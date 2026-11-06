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
const GROWTH_MS = 8 * 60 * 60 * 1000;
const WATER_REDUCTION_MS = 4 * 60 * 60 * 1000;
function publicPlots(rawPlots) {
  const now=Date.now();
  return (Array.isArray(rawPlots)?rawPlots:[]).map(item=>{
    const plot={...item};
    if(plot.grown&&!plot.readyAt) return plot;
    if(!plot.readyAt) {
      plot.plantedAt=plot.plantedAt||new Date(now).toISOString();
      plot.readyAt=new Date(now+GROWTH_MS).toISOString();
      plot.watered=Boolean(plot.watered);
    }
    plot.grown=new Date(plot.readyAt).getTime()<=now;
    return plot;
  });
}
const state = p => ({
  coins:p.coins, apples:p.apples, fruitInventory:p.fruit_inventory||{}, processedInventory:p.processed_inventory||{}, hasWarehouse:Boolean(p.has_warehouse), warehouseLevel:Number(p.warehouse_level)||0, landLevel:Math.min(5,Number(p.land_level)||1), unlockedPlots:[0,36,100,196,324,400][Math.min(5,Math.max(1,Number(p.land_level)||1))], seeds:p.seeds, seedInventory:p.seed_inventory||{}, orchardLevel:p.orchard_level,
  experience:Number(p.experience)||0, playerLevel:Number(p.player_level)||1,
  plots:publicPlots(p.plots)
});
function xpForLevel(level){
  const thresholds=[0,0,100,250,450,700,1000];
  if(level<thresholds.length) return thresholds[level];
  const extra=level-5;
  return 1000+extra*400+extra*(extra-1)*25;
}
async function awardExperience(c,playerId,player,amount){
  const current=await c.query(
    'UPDATE players SET experience=COALESCE(experience,0)+$2,updated_at=NOW() WHERE telegram_id=$1 RETURNING experience,player_level',
    [playerId,amount]
  );
  if(!current.rowCount) reject(404,'Player not found');
  const experience=Number(current.rows[0].experience)||0;
  const previousLevel=Number(current.rows[0].player_level)||1;
  let level=previousLevel;
  while(experience>=xpForLevel(level+1)) level++;
  const bonus=(level-previousLevel)*25;
  if(level!==previousLevel || bonus>0){
    await c.query('UPDATE players SET player_level=$2,coins=coins+$3,updated_at=NOW() WHERE telegram_id=$1',[playerId,level,bonus]);
  }
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
      const migratedPlots=publicPlots(q.rows[0].plots);
      await c.query('UPDATE players SET plots=$2::jsonb WHERE telegram_id=$1',[u.id,JSON.stringify(migratedPlots)]);
      q.rows[0].plots=migratedPlots;
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
app.post('/api/game/plant',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=Array.isArray(p.plots)?p.plots:[];
  const type=String(req.body?.treeType||'apple');
  const costs={apple:100,peach:300,cherry:700,pear:1200,orange:2000,mango:3500};
  if(!Number.isInteger(i)||i<0||i>=400) reject(400,'Invalid plot');
  const landLevel=Math.min(5,Math.max(1,Number(p.land_level)||1));
  const side=[0,6,10,14,18,20][landLevel],start=Math.floor((20-side)/2),x=Math.floor(i/20),z=i%20;
  if(x<start||x>=start+side||z<start||z>=start+side) reject(403,'This land plot is locked. Expand your territory first.');
  if(plots.some(x=>x.index===i)) reject(409,'Plot occupied');
  if(!Object.prototype.hasOwnProperty.call(costs,type)) reject(400,'Unknown fruit tree');
  if(p.coins<costs[type]) reject(409,'Not enough Green Coin');
  const now=new Date();
  const newPlot={index:i,type,grown:false,plantedAt:now.toISOString(),readyAt:new Date(now.getTime()+GROWTH_MS).toISOString(),watered:false};
  await c.query('UPDATE players SET coins=coins-$2,plots=plots || $3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,costs[type],JSON.stringify([newPlot])]);
  await awardExperience(c,req.playerId,p,5);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/water',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=(Array.isArray(p.plots)?p.plots:[]).map(x=>({...x}));
  const plot=plots.find(x=>x.index===i);if(!plot) reject(404,'Tree not found');
  const now=Date.now();
  if(plot.grown&&!plot.readyAt) reject(409,'Harvest is already ready');
  if(!plot.readyAt){plot.plantedAt=plot.plantedAt||new Date(now).toISOString();plot.readyAt=new Date(now+GROWTH_MS).toISOString();}
  if(new Date(plot.readyAt).getTime()<=now) reject(409,'Harvest is already ready');
  if(plot.watered) reject(409,'Tree has already been watered this cycle');
  plot.readyAt=new Date(Math.max(now,new Date(plot.readyAt).getTime()-WATER_REDUCTION_MS)).toISOString();
  plot.watered=true;
  plot.grown=new Date(plot.readyAt).getTime()<=now;
  await c.query('UPDATE players SET plots=$2::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify(plots)]);
  await awardExperience(c,req.playerId,p,2);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/harvest',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const i=Number(req.body?.plotIndex);const plots=(Array.isArray(p.plots)?p.plots:[]).map(x=>({...x}));
  const plot=plots.find(x=>x.index===i);if(!plot) reject(404,'Tree not found');
  const now=Date.now();
  const ready=(plot.grown&&!plot.readyAt)||(plot.readyAt&&new Date(plot.readyAt).getTime()<=now);
  if(!ready) reject(409,'Harvest is not ready yet');
  const capacity=p.has_warehouse?100*(Number(p.warehouse_level)||1):20;
  const inventory=p.fruit_inventory&&typeof p.fruit_inventory==='object'?{...p.fruit_inventory}:{};
  const stored=Number(p.apples||0)+Object.values(inventory).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
  const amount=Math.min(5,Math.max(0,capacity-stored));
  const type=({apple:'apple',peach:'peach',cherry:'cherry',pear:'pear',orange:'orange',mango:'mango'})[plot.type||'apple'];
  plot.plantedAt=new Date(now).toISOString();
  plot.readyAt=new Date(now+GROWTH_MS).toISOString();
  plot.watered=false;
  plot.grown=false;
  if(type==='apple'){
    await c.query('UPDATE players SET apples=apples+$2,plots=$3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,amount,JSON.stringify(plots)]);
  }else{
    inventory[type]=(Number(inventory[type])||0)+amount;
    await c.query('UPDATE players SET fruit_inventory=$2::jsonb,plots=$3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify(inventory),JSON.stringify(plots)]);
  }
  await awardExperience(c,req.playerId,p,10);
  return {player:await loadState(c,req.playerId)};
}));
app.post('/api/game/harvest-all',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const plots=(Array.isArray(p.plots)?p.plots:[]).map(x=>({...x}));
  const capacity=p.has_warehouse?100*(Number(p.warehouse_level)||1):20;
  const inventory=p.fruit_inventory&&typeof p.fruit_inventory==='object'?{...p.fruit_inventory}:{};
  let stored=Number(p.apples||0)+Object.values(inventory).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
  const perTree=5;
  const now=Date.now();
  let harvested=0,totalFruits=0;
  for(const plot of plots){
    const ready=(plot.grown&&!plot.readyAt)||(plot.readyAt&&new Date(plot.readyAt).getTime()<=now);
    if(!ready) continue;
    const amount=Math.min(perTree,Math.max(0,capacity-stored));
    if(amount<1) break;
    const type=({apple:'apple',peach:'peach',cherry:'cherry',pear:'pear',orange:'orange',mango:'mango'})[plot.type||'apple'];
    if(type==='apple'){
      await c.query('UPDATE players SET apples=apples+$2 WHERE telegram_id=$1',[req.playerId,amount]);
    }else{
      inventory[type]=(Number(inventory[type])||0)+amount;
    }
    stored+=amount;totalFruits+=amount;harvested++;
    plot.plantedAt=new Date(now).toISOString();
    plot.readyAt=new Date(now+GROWTH_MS).toISOString();
    plot.watered=false;plot.grown=false;
  }
  if(!harvested) reject(409,'No ripe fruit to harvest');
  await c.query('UPDATE players SET fruit_inventory=$2::jsonb,plots=$3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify(inventory),JSON.stringify(plots)]);
  for(let n=0;n<harvested;n++) await awardExperience(c,req.playerId,p,10);
  return {player:await loadState(c,req.playerId),harvested,totalFruits};
}));
app.post('/api/game/sell',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const inventory=p.fruit_inventory&&typeof p.fruit_inventory==='object'?p.fruit_inventory:{};
  const processed=p.processed_inventory&&typeof p.processed_inventory==='object'?p.processed_inventory:{};
  const salePrices={peach:7,cherry:12,pear:9,orange:15,mango:22};
  let earned=Number(p.apples||0)*(1+p.orchard_level);
  for(const [type,price] of Object.entries(salePrices)) earned+=(Math.max(0,Number(inventory[type])||0))*price;
  const baseApplePrice=1+(Number(p.orchard_level)||1);
  for(const [key,count] of Object.entries(processed)){
    const match=key.match(/^(apple|peach|cherry|pear|orange|mango)_(juice|jam)$/);
    if(!match) continue;
    const base=match[1]==='apple'?baseApplePrice:(salePrices[match[1]]||1);
    earned+=Math.max(0,Number(count)||0)*base*(match[2]==='juice'?6.5:12);
  }
  const total=Number(p.apples||0)+Object.values(inventory).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0)+Object.values(processed).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
  if(total<1) reject(409,'No fruit or processed goods to sell');
  await c.query("UPDATE players SET coins=coins+$2,apples=0,fruit_inventory='{}'::jsonb,processed_inventory='{}'::jsonb,updated_at=NOW() WHERE telegram_id=$1",[req.playerId,Math.floor(earned)]);
  await awardExperience(c,req.playerId,p,5);
  return {player:await loadState(c,req.playerId),earned};
}));
app.post('/api/game/process',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const type=String(req.body?.fruitType||''),kind=String(req.body?.kind||'');
  if(!['apple','peach','cherry','pear','orange','mango'].includes(type)) reject(400,'Unknown fruit type');
  if(!['juice','jam'].includes(kind)) reject(400,'Unknown processing recipe');
  const quantity=1;
  const need=kind==='juice'?5:8;
  const inventory=p.fruit_inventory&&typeof p.fruit_inventory==='object'?{...p.fruit_inventory}:{};
  const available=type==='apple'?Number(p.apples)||0:Number(inventory[type])||0;
  if(available<need) reject(409,'Not enough fruit for this recipe');
  if(type==='apple') await c.query('UPDATE players SET apples=apples-$2 WHERE telegram_id=$1',[req.playerId,need]);
  else inventory[type]-=need;
  const processed=p.processed_inventory&&typeof p.processed_inventory==='object'?{...p.processed_inventory}:{};
  const key=type+'_'+kind;processed[key]=(Number(processed[key])||0)+quantity;
  await c.query('UPDATE players SET fruit_inventory=$2::jsonb,processed_inventory=$3::jsonb,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,JSON.stringify(inventory),JSON.stringify(processed)]);
  return {player:await loadState(c,req.playerId),product:key,quantity};
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
app.post('/api/game/upgrade-orchard',auth,(req,res)=>mutate(req,res,async(c,p)=>{
  const cost=150*p.orchard_level;if(p.coins<cost) reject(409,'Not enough Green Coin');
  await c.query('UPDATE players SET coins=coins-$2,orchard_level=orchard_level+1,updated_at=NOW() WHERE telegram_id=$1',[req.playerId,cost]);
  return {player:await loadState(c,req.playerId)};
}));

app.use((err,_req,res,_next)=>{console.error(err.message);res.status(500).json({error:'Internal server error'});});
const port=Number(process.env.PORT||3000);
db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS fruit_inventory JSONB NOT NULL DEFAULT '{}'::jsonb")
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS processed_inventory JSONB NOT NULL DEFAULT '{}'::jsonb"))
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS land_level INTEGER NOT NULL DEFAULT 1"))
.then(()=>db.query("UPDATE players SET land_level=GREATEST(COALESCE(land_level,1),1)"))
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS seed_inventory JSONB NOT NULL DEFAULT '{}'::jsonb"))
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS experience INTEGER NOT NULL DEFAULT 0"))
.then(()=>db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS player_level INTEGER NOT NULL DEFAULT 1"))
.then(()=>db.query("UPDATE players SET experience=COALESCE(experience,0),player_level=COALESCE(player_level,1)"))
.then(()=>db.query("ALTER TABLE players ALTER COLUMN experience SET DEFAULT 0, ALTER COLUMN experience SET NOT NULL, ALTER COLUMN player_level SET DEFAULT 1, ALTER COLUMN player_level SET NOT NULL"))
.then(()=>app.listen(port,()=>console.log('GREEN WORLD API listening on '+port)))
.catch(error=>{console.error('Database migration failed:',error);process.exit(1);});
