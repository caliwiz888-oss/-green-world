import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { verifyTelegramInitData } from './security.js';

const app = express();
const { Pool } = pg;
const pgSslMode = process.env.PGSSLMODE || (process.env.NODE_ENV === 'production' ? 'require' : 'disable');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslMode === 'disable' ? false : {
    rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false'
  }
});
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const ISSUER = process.env.JWT_ISSUER || 'green-world-api';
const ORIGINS = (process.env.WEB_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const COOKIE = 'gw_refresh';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || (COOKIE_SECURE ? 'none' : 'lax');
if (!['lax', 'strict', 'none'].includes(COOKIE_SAME_SITE) || (COOKIE_SAME_SITE === 'none' && !COOKIE_SECURE)) {
  throw new Error('COOKIE_SAME_SITE=none requires COOKIE_SECURE=true');
}
const DAY = 86400000;

if (!BOT_TOKEN || !JWT_SECRET || JWT_SECRET.length < 32 || !process.env.DATABASE_URL) {
  throw new Error('Configure DATABASE_URL, TELEGRAM_BOT_TOKEN and a 32+ character JWT_ACCESS_SECRET');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, done) {
    if (origin && !ORIGINS.includes(origin)) console.warn('[cors] blocked origin:', origin);
    done(null, !origin || ORIGINS.includes(origin));
  },
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '12kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60000, limit: 80, standardHeaders: true, legacyHeaders: false }));

function originGuard(req, res, next) {
  if (!req.get('origin') || !ORIGINS.includes(req.get('origin'))) return res.status(403).json({ error: 'Origin not allowed' });
  next();
}
function telegramUser(raw) {
  return verifyTelegramInitData(raw, BOT_TOKEN);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const refreshCookie = { httpOnly: true, secure: COOKIE_SECURE, sameSite: COOKIE_SAME_SITE, path: '/api/auth', maxAge: 30*DAY };
const issueAccess = id => jwt.sign({}, JWT_SECRET, { algorithm: 'HS256', subject: String(id), issuer: ISSUER, expiresIn: '15m' });
function auth(req,res,next) {
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer /,'');
    const payload = jwt.verify(token, JWT_SECRET, { algorithms:['HS256'], issuer:ISSUER });
    if (!/^\d{1,20}$/.test(String(payload.sub))) throw new Error('Bad subject');
    req.playerId = String(payload.sub); next();
  } catch { res.status(401).json({error:'Authentication required'}); }
}
async function mutate(req,res,fn) {
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    const q=await c.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[req.playerId]);
    if(!q.rowCount) { await c.query('ROLLBACK'); return res.status(404).json({error:'Player not found'}); }
    const result=await fn(c,q.rows[0]);
    await c.query('COMMIT');
    return res.json(result);
  } catch(e) {
    await c.query('ROLLBACK');
    return res.status(e.status||500).json({error:e.publicMessage||'Game action failed'});
  } finally { c.release(); }
}
function reject(status,message) { const e=new Error(message);e.status=status;e.publicMessage=message;throw e; }
async function loadState(c,id) { const q=await c.query('SELECT * FROM players WHERE telegram_id=$1',[id]);return state(q.rows[0]); }

app.get('/health',(_req,res)=>res.json({ok:true,service:'green-world-api'}));

app.post('/api/auth/telegram',(req,res,next)=>{
  console.info('[auth] Telegram login request:', {
    origin: req.get('origin') || null,
    hasInitData: typeof req.body?.initData === 'string',
    initDataLength: typeof req.body?.initData === 'string' ? req.body.initData.length : 0
  });
  next();
},originGuard,async(req,res)=>{
  try {
    const u=telegramUser(req.body?.initData);
    const c=await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO players(telegram_id,username,first_name) VALUES($1,$2,$3)
        ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,updated_at=NOW()`,
        [u.id,u.username,u.firstName]);
      const raw=crypto.randomBytes(48).toString('base64url');
      const family=crypto.randomUUID();
      await c.query(`INSERT INTO refresh_sessions(id,telegram_id,token_hash,family_id,expires_at)
        VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 days')`,
        [crypto.randomUUID(),u.id,hash(raw),family]);
      const q=await c.query('SELECT * FROM players WHERE telegram_id=$1',[u.id]);
      await c.query('COMMIT');
      res.cookie(COOKIE,raw,refreshCookie);
      res.json({accessToken:issueAccess(u.id),player:state(q.rows[0])});
    } catch(e) { await c.query('ROLLBACK');throw e; } finally { c.release(); }
  } catch(e) { res.status(401).json({error:'Telegram authentication failed'}); }
});

app.post('/api/auth/refresh',originGuard,async(req,res)=>{
  const raw=req.cookies[COOKIE];
  if(!raw) return res.status(401).json({error:'Refresh session missing'});
  const c=await db.connect();
  try {
    await c.query('BEGIN');
    const q=await c.query('SELECT * FROM refresh_sessions WHERE token_hash=$1 FOR UPDATE',[hash(raw)]);
    if(!q.rowCount) { await c.query('ROLLBACK');res.clearCookie(COOKIE,refreshCookie);return res.status(401).json({error:'Session invalid'}); }
    const session=q.rows[0];
    if(session.revoked_at || new Date(session.expires_at)<=new Date()) {
      await c.query('UPDATE refresh_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE family_id=$1',[session.family_id]);
      await c.query('COMMIT');res.clearCookie(COOKIE,refreshCookie);return res.status(401).json({error:'Session expired'});
    }
    const next=crypto.randomBytes(48).toString('base64url');
    await c.query('UPDATE refresh_sessions SET revoked_at=NOW() WHERE id=$1',[session.id]);
    await c.query(`INSERT INTO refresh_sessions(id,telegram_id,token_hash,family_id,expires_at)
      VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 days')`,
      [crypto.randomUUID(),session.telegram_id,hash(next),session.family_id]);
    await c.query('COMMIT');
    res.cookie(COOKIE,next,refreshCookie);
    res.json({accessToken:issueAccess(String(session.telegram_id))});
  } catch(e) { await c.query('ROLLBACK');res.status(500).json({error:'Could not refresh session'}); }
  finally { c.release(); }
});

app.post('/api/auth/logout',originGuard,async(req,res)=>{
  try {
    const raw=req.cookies[COOKIE];
    if(raw) await db.query('UPDATE refresh_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL',[hash(raw)]);
    res.clearCookie(COOKIE,refreshCookie);
    return res.json({ok:true});
  } catch(error) {
    console.error('[auth/logout] Session revocation failed:',error);
    return res.status(500).json({error:'Could not log out'});
  }
});
app.get('/api/me',auth,async(req,res)=>{
  try {
    const q=await db.query('SELECT * FROM players WHERE telegram_id=$1',[req.playerId]);
    if(!q.rowCount) return res.status(404).json({error:'Player not found'});
    return res.json({player:state(q.rows[0])});
  } catch(error) {
    console.error('[api/me] Player state load failed:',error);
    return res.status(500).json({error:'Could not load player'});
  }
});

app.get('/api/game/daily-reward',auth,async(req,res)=>{
  try {
    const q=await db.query(`SELECT
      COALESCE(last_daily_claim = CURRENT_DATE,FALSE) AS claimed_today,
      CASE WHEN last_daily_claim = CURRENT_DATE - 1 THEN daily_streak + 1 ELSE 1 END AS next_streak
      FROM players WHERE telegram_id=$1`,[req.playerId]);
    if(!q.rowCount) return res.status(404).json({error:'Player not found'});
    const rewards=[10,15,20,25,30,40,100];
    const day=((Number(q.rows[0].next_streak)-1)%7)+1;
    res.json({claimedToday:Boolean(q.rows[0].claimed_today),day,reward:rewards[day-1]});
  } catch(error) { console.error('Daily reward status failed:',error); res.status(500).json({error:'Could not load daily reward'}); }
});
app.post('/api/game/daily-reward/claim',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const q=await c.query(`SELECT
    COALESCE(last_daily_claim = CURRENT_DATE,FALSE) AS claimed_today,
    CASE WHEN last_daily_claim = CURRENT_DATE - 1 THEN daily_streak + 1 ELSE 1 END AS next_streak
    FROM players WHERE telegram_id=$1`,[req.playerId]);
  if(!q.rowCount) reject(404,'Player not found');
  if(q.rows[0].claimed_today) reject(409,'Daily reward already claimed today');
  const rewards=[10,15,20,25,30,40,100];
  const day=((Number(q.rows[0].next_streak)-1)%7)+1;
  const reward=rewards[day-1];
  await c.query('UPDATE players SET coins=coins+$2,last_daily_claim=CURRENT_DATE,daily_streak=$3,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,reward,day]);
  return {player:await loadState(c,req.playerId),claimedToday:true,day,reward};
}));
app.post('/api/game/expand-land',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const level=Math.min(5,Math.max(1,Number(p.land_level)||1));
  if(level>=5) reject(409,'All land is already unlocked');
  const costs=[0,500,1500,3500,7000];
  const cost=costs[level];
  if(Number(p.coins)<cost) reject(409,'Not enough Green Coin');
  await c.query('UPDATE players SET coins=coins-$2,land_level=land_level+1,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,cost]);
  return {player:await loadState(c,req.playerId),unlockedPlots:[0,36,100,196,324,400][level+1]};
}));
app.use((err,_req,res,_next)=>{console.error(err.message);res.status(500).json({error:'Internal server error'});});
const port=Number(process.env.PORT||3000);
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS land_level INTEGER NOT NULL DEFAULT 1"))
.then(()=>db.query("UPDATE players SET land_level=GREATEST(COALESCE(land_level,1),1)"))
.then(()=>app.listen(port,()=>console.log('GREEN WORLD API listening on '+port)))
.catch(error=>{console.error('Database migration failed:',error);process.exit(1);});
