import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const app = express();
const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JWT_SECRET = process.env.JWT_ACCESS_SECRET;
const ISSUER = process.env.JWT_ISSUER || 'green-world-api';
const ORIGINS = (process.env.WEB_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const COOKIE = 'gw_refresh';
const DAY = 86400000;

if (!BOT_TOKEN || !JWT_SECRET || JWT_SECRET.length < 32 || !process.env.DATABASE_URL) {
  throw new Error('Configure DATABASE_URL, TELEGRAM_BOT_TOKEN and a 32+ character JWT_ACCESS_SECRET');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, done) { done(null, !origin || ORIGINS.includes(origin)); },
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
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Invalid initData');
  const p = new URLSearchParams(raw);
  if (p.getAll('hash').length !== 1 || p.getAll('auth_date').length !== 1 || p.getAll('user').length !== 1) throw new Error('Invalid initData fields');
  const hash = p.get('hash');
  p.delete('hash');
  const check = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + '=' + v).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', key).update(check).digest('hex');
  if (!/^[a-f0-9]{64}$/i.test(hash) || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Bad Telegram signature');
  const authDate = Number(p.get('auth_date'));
  const now = Math.floor(Date.now()/1000);
  if (!Number.isInteger(authDate) || authDate > now + 30 || now - authDate > 300) throw new Error('Expired Telegram data');
  const user = JSON.parse(p.get('user'));
  if (!/^\d{1,20}$/.test(String(user.id))) throw new Error('Bad user id');
  return { id: String(user.id), username: typeof user.username === 'string' ? user.username.slice(0,64) : null, firstName: typeof user.first_name === 'string' ? user.first_name.slice(0,128) : '' };
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const refreshCookie = { httpOnly: true, secure: true, sameSite: 'none', path: '/api/auth', maxAge: 30*DAY };
const issueAccess = id => jwt.sign({}, JWT_SECRET, { algorithm: 'HS256', subject: String(id), issuer: ISSUER, expiresIn: '15m' });
function auth(req,res,next) {
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer /,'');
    const payload = jwt.verify(token, JWT_SECRET, { algorithms:['HS256'], issuer:ISSUER });
    if (!/^\d{1,20}$/.test(String(payload.sub))) throw new Error('Bad subject');
    req.playerId = String(payload.sub); next();
  } catch { res.status(401).json({error:'Authentication required'}); }
}
const state = p => ({
  coins:p.coins, apples:p.apples, seeds:p.seeds, orchardLevel:p.orchard_level,
  hasWarehouse:p.has_warehouse, hasMarket:p.has_market, hasGreenhouse:p.has_greenhouse,
  plots:p.plots, appleCapacity:p.has_warehouse?100:20
});
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

app.post('/api/auth/telegram',originGuard,async(req,res)=>{
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
  const raw=req.cookies[COOKIE];
  if(raw) await db.query('UPDATE refresh_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL',[hash(raw)]);
  res.clearCookie(COOKIE,refreshCookie);res.json({ok:true});
});
app.get('/api/me',auth,async(req,res)=>{
  const q=await db.query('SELECT * FROM players WHERE telegram_id=$1',[req.playerId]);
  if(!q.rowCount) return res.status(404).json({error:'Player not found'});
  res.json({player:state(q.rows[0])});
});

app.post('/api/game/plant',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=Array.isArray(p.plots)?p.plots:[];
  if(!Number.isInteger(i)||i<0||i>=400) reject(400,'Invalid plot');
  if(plots.some(x=>x.index===i)) reject(409,'Plot occupied');
  if(p.seeds<1||p.coins<10) reject(409,'Not enough seeds or Green Coin');
  await c.query('UPDATE players SET coins=coins-10,seeds=seeds-1,plots=plots || $2::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify([{index:i,grown:false}])]);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/water',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=(Array.isArray(p.plots)?p.plots:[]).map(x=>({...x}));
  const plot=plots.find(x=>x.index===i);if(!plot||plot.grown) reject(409,'Tree is not ready for watering');
  plot.grown=true;
  await c.query('UPDATE players SET plots=$2::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify(plots)]);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/harvest',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=(Array.isArray(p.plots)?p.plots:[]).map(x=>({...x}));
  const plot=plots.find(x=>x.index===i);if(!plot?.grown) reject(409,'Tree is not ready to harvest');
  const amount=p.has_greenhouse?8:5,cap=p.has_warehouse?100:20;
  if(p.apples+amount>cap) reject(409,'Warehouse is full');
  plot.grown=false;
  await c.query('UPDATE players SET apples=apples+$2,plots=$3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,amount,JSON.stringify(plots)]);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/sell',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  if(p.apples<1) reject(409,'No apples to sell');
  const earned=p.apples*(1+p.orchard_level+(p.has_market?1:0));
  await c.query('UPDATE players SET coins=coins+$2,apples=0,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,earned]);
  return {player:await loadState(c,req.playerId),earned};
}));
app.post('/api/game/buy-seeds',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  if(p.coins<30) reject(409,'Not enough Green Coin');
  await c.query('UPDATE players SET coins=coins-30,seeds=seeds+5,updated_at=NOW() WHERE telegram_id=$1',[req.playerId]);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/build',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const options={warehouse:['has_warehouse',80],market:['has_market',120],greenhouse:['has_greenhouse',180]};
  const option=options[req.body?.kind];if(!option) reject(400,'Unknown building');
  if(p[option[0]]) reject(409,'Building already exists');
  if(p.coins<option[1]) reject(409,'Not enough Green Coin');
  await c.query(`UPDATE players SET coins=coins-$2,${option[0]}=TRUE,updated_at=NOW() WHERE telegram_id=$1`,[req.playerId,option[1]]);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/upgrade-orchard',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const cost=p.orchard_level*150;if(p.coins<cost) reject(409,'Not enough Green Coin');
  await c.query('UPDATE players SET coins=coins-$2,orchard_level=orchard_level+1,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,cost]);
  return {player:await loadState(c,req.playerId)};
}));

app.use((err,_req,res,_next)=>{console.error(err.message);res.status(500).json({error:'Internal server error'});});
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log('GREEN WORLD API listening on '+port));
