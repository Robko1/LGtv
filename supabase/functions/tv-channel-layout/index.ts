// Independent cloud storage for the TV's Hungarian channel layout.
// It deliberately has no dependency on TV Doctor memory, sync queues, or reset actions.
// Authentication reuses the TV's existing paired-device credential so users do not
// need to pair again; layout data itself lives in a separate table and endpoint.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-tv-device-id, x-tv-device-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const cleanDeviceId = (v) => String(v || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0,64);
const cleanToken = (v) => {
  const s=String(v||"").trim();
  return s.length>=32 && s.length<=160 && /^[a-zA-Z0-9_-]+$/.test(s) ? s : "";
};
const sha256 = async (s) => {
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");
};
const safeEqual = (a,b) => {
  if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length||!a.length)return false;
  let d=0; for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0;
};
const json = async (r) => { try { return await r.json(); } catch { return []; } };

Deno.serve(async (req) => {
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(req.method!=="POST") return reply(405,{ok:false,error:"method_not_allowed"});
  const url=Deno.env.get("SUPABASE_URL")||"";
  const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!key)return reply(503,{ok:false,error:"service_unavailable"});
  let body; try { body=await req.json(); } catch { return reply(400,{ok:false,error:"invalid_json"}); }
  const deviceId=cleanDeviceId(req.headers.get("x-tv-device-id")||body.deviceId);
  const token=cleanToken(req.headers.get("x-tv-device-token")||body.deviceToken);
  if(!deviceId||!token)return reply(401,{ok:false,error:"pairing_required"});
  const headers={apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"};
  const authUrl=url+"/rest/v1/tv_doctor_paired_devices?device_id=eq."+encodeURIComponent(deviceId)+"&select=device_id,token_hash,previous_token_hash,previous_token_grace_until,token_expires_at,revoked&limit=1";
  const authResp=await fetch(authUrl,{headers});
  if(!authResp.ok)return reply(503,{ok:false,error:"auth_check_failed"});
  const rows=await json(authResp); const device=Array.isArray(rows)?rows[0]:null;
  if(!device||device.revoked===true||Date.parse(device.token_expires_at||"")<=Date.now())
    return reply(401,{ok:false,error:"device_not_authorized"});
  const hash=await sha256(token);
  const current=safeEqual(hash,String(device.token_hash||""));
  const grace=Date.parse(device.previous_token_grace_until||"");
  const previous=!current&&device.previous_token_hash&&grace>Date.now()&&safeEqual(hash,String(device.previous_token_hash));
  if(!current&&!previous)return reply(401,{ok:false,error:"invalid_device_token"});

  const table=url+"/rest/v1/tv_channel_layout_snapshots";
  const providerId="__HU_LAYOUT_GLOBAL__";
  if(body.action==="layout_upsert"){
    const layout=body.layout;
    if(!layout||typeof layout!=="object"||(!Array.isArray(layout.channelOrder)&&!Array.isArray(layout.fingerprintOrder)))
      return reply(400,{ok:false,error:"invalid_layout"});

    // A személyes magyar elrendezés nem tartalmazhatja a teljes szolgáltatói katalógust.
    // 1000 bőven elegendő a magyar főoldali csatornákhoz és a kedvenc mappákhoz.
    const orderCount=Array.isArray(layout.channelOrder)?layout.channelOrder.length:0;
    const fingerprintCount=Array.isArray(layout.fingerprintOrder)?layout.fingerprintOrder.length:0;
    if(orderCount>1000||fingerprintCount>1000)
      return reply(413,{ok:false,error:"layout_channel_limit_exceeded",maxChannels:1000,received:Math.max(orderCount,fingerprintCount)});

    let serialized; try { serialized=JSON.stringify(layout); } catch { return reply(400,{ok:false,error:"invalid_layout"}); }
    if(new TextEncoder().encode(serialized).length>4500000)return reply(413,{ok:false,error:"layout_too_large"});

    // A mentett sorrend az egyetlen forrás; a Doktor magyar hatóköre csak
    // külön metaadat, és nem vesz részt a csatornasorrend visszaállításában.
    const rawOrder=Array.isArray(layout.channelOrder)
      ? layout.channelOrder
      : (Array.isArray(layout.fingerprintOrder)?layout.fingerprintOrder.map(item=>item?.id).filter(Boolean):[]);
    const channelOrder=Array.from(new Set(rawOrder.map(value=>String(value).trim()).filter(Boolean))).slice(0,1000);
    const allowedIds=new Set(channelOrder);
    const hungarianChannelIds=Array.isArray(layout.hungarianChannelIds)
      ? Array.from(new Set(layout.hungarianChannelIds.map(value=>String(value).trim()).filter(id=>allowedIds.has(id)))).slice(0,1000)
      : [];
    const safeFolders=Array.isArray(layout.folders)?layout.folders.map(folder=>({
      ...folder,
      channelIds:Array.isArray(folder?.channelIds)?folder.channelIds.map(String).filter(id=>allowedIds.has(id)):[]
    })):[];
    const now=new Date().toISOString();
    const snapshot={
      ...layout,
      channelOrder,
      hungarianChannelIds,
      hungarianChannelCount:hungarianChannelIds.length,
      folders:safeFolders,
      providerId,
      providerName:"Magyar csatornák"
    };
    const saved=await fetch(table+"?on_conflict=device_id,provider_id",{
      method:"POST",headers:{...headers,Prefer:"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify([{device_id:deviceId,provider_id:providerId,provider_name:"Magyar csatornák",snapshot,updated_at:now,created_at:now}])
    });
    if(!saved.ok)return reply(503,{ok:false,error:"layout_upsert_failed"});
    return reply(200,{ok:true,saved:true,providerId,providerName:"Magyar csatornák",updatedAt:now});
  }
  if(body.action==="layout_fetch"){
    const r=await fetch(table+"?device_id=eq."+encodeURIComponent(deviceId)+"&provider_id=eq."+encodeURIComponent(providerId)+"&select=snapshot,provider_id,provider_name,updated_at,created_at&limit=1",{headers});
    if(!r.ok)return reply(503,{ok:false,error:"layout_fetch_failed"});
    const found=await json(r); const row=Array.isArray(found)?found[0]:null;
    if(!row?.snapshot)return reply(200,{ok:true,found:false,layout:null,snapshot:null});
    return reply(200,{ok:true,found:true,layout:row.snapshot,snapshot:row.snapshot,providerId:row.provider_id,providerName:row.provider_name,updatedAt:row.updated_at,createdAt:row.created_at});
  }
  return reply(400,{ok:false,error:"unknown_action"});
});