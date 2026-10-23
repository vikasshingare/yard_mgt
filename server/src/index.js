require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./db');
const { installAuth, requirePermission } = require('./auth');
const { installDomainRoutes } = require('./domain-routes');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch (error) { res.status(503).json({ status: 'degraded', database: 'unavailable', detail: error.code }); }
});

installAuth(app, express);
installDomainRoutes(app, pool, requirePermission);

app.get('/api/locations', requirePermission('yard:read'), async (_req, res, next) => {
  try { const [rows] = await pool.query(`SELECT l.*, c.container_number,c.iso_size,c.cargo_status,c.hold_status,
    c.current_location_id AS container_current_location_id,c.planned_destination_location_id,
    t.id AS active_task_id,t.task_type AS active_task_type,t.status AS active_task_status,
    t.assigned_operator AS active_task_operator,t.assigned_equipment AS active_task_equipment,
    t.reason AS active_task_reason,t.created_at AS active_task_created_at,tc.container_number AS reserved_container_number,
    pc.container_number AS planned_container_number,pc.current_location_id AS planned_container_current_location_id
    FROM yard_locations l LEFT JOIN containers c ON c.id=l.occupied_container_id
    LEFT JOIN movement_tasks t ON t.id=l.reserved_task_id AND t.status IN ('QUEUED','ASSIGNED','IN_PROGRESS','PICKUP_CONFIRMED','AWAITING_APPROVAL','EXCEPTION')
    LEFT JOIN containers tc ON tc.id=t.container_id
    LEFT JOIN containers pc ON pc.planned_destination_location_id=l.id AND pc.status<>'GATED_OUT'
    ORDER BY l.depot_code,l.block_code,l.row_code,l.bay_code,l.tier,l.position_code`); res.json(rows); }
  catch (error) { next(error); }
});

app.get('/api/tasks', requirePermission('tasks:read'), async (_req, res, next) => {
  try { const scoped = _req.user.role_name === 'Reach-Stacker Operator'; const [rows] = await pool.query(`SELECT t.*,c.container_number,src.location_code AS source_location,dst.location_code AS destination_location,actual.location_code AS actual_destination_location FROM movement_tasks t JOIN containers c ON c.id=t.container_id LEFT JOIN yard_locations src ON src.id=t.source_location_id LEFT JOIN yard_locations dst ON dst.id=t.destination_location_id LEFT JOIN yard_locations actual ON actual.id=t.actual_destination_location_id WHERE (?=0 OR t.assigned_operator=?) ORDER BY FIELD(t.status,'PICKUP_CONFIRMED','IN_PROGRESS','ASSIGNED','QUEUED','AWAITING_APPROVAL','EXCEPTION','COMPLETED'), FIELD(t.priority,'URGENT','HIGH','NORMAL','LOW'),t.created_at DESC LIMIT 250`, [scoped?1:0,_req.user.email]); res.json(rows); }
  catch (error) { next(error); }
});
app.get('/api/tasks/:id/history',requirePermission('tasks:read'),async(req,res,next)=>{try{const [[task]]=await pool.query('SELECT id,assigned_operator FROM movement_tasks WHERE id=?',[req.params.id]);if(!task)return res.status(404).json({error:'Task not found.'});if(req.user.role_name==='Reach-Stacker Operator'&&task.assigned_operator!==req.user.email)return res.status(403).json({error:'Operators can only view history for their assigned tasks.'});const [rows]=await pool.query('SELECT id,event_type,actor,detail,created_at FROM movement_task_events WHERE task_id=? ORDER BY created_at DESC,id DESC',[req.params.id]);res.json(rows);}catch(error){next(error);}});

app.get('/api/operators', requirePermission('tasks:create'), async (_req,res,next) => {
  try { const [rows] = await pool.query("SELECT id,email,display_name FROM users WHERE role_name='Reach-Stacker Operator' AND is_active=1 ORDER BY display_name"); res.json(rows); }
  catch(error) { next(error); }
});

app.get('/api/visits/open', async (req,res,next) => {
  if (!req.user.permissions.some(p => p === 'gate:in' || p === 'gate:out')) return res.status(403).json({error:'Your role cannot view gate visits.'});
  try {
    const [rows] = await pool.query(`SELECT v.id,v.container_id,v.direction,v.truck_registration,v.driver_name,v.manifest_ref,v.gate_in_at,v.status,c.container_number,c.hold_status,c.current_location_id FROM visits v JOIN containers c ON c.id=v.container_id WHERE v.status='OPEN' ORDER BY v.gate_in_at LIMIT 200`);
    res.json(rows);
  } catch(error) { next(error); }
});

app.get('/api/events', requirePermission('containers:read'), async (_req,res,next) => {
  try { const [rows] = await pool.query('SELECT * FROM movement_events ORDER BY created_at DESC LIMIT 100'); res.json(rows); }
  catch(error) { next(error); }
});

async function readRule(connection, code, fallback) {
  const [[row]] = await connection.query('SELECT value_json FROM operational_rules WHERE rule_code=? AND is_active=1',[code]);
  if (!row) return fallback;
  if (typeof row.value_json !== 'string') return row.value_json;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

async function checkSlotCompatibility(connection, container, slot, rules, options={}) {
  const reasons=[];
  if (!slot || !slot.is_active || slot.is_blocked || (slot.availability_status && slot.availability_status!=='AVAILABLE')) reasons.push('Location is blocked, retired, inactive, or unavailable.');
  if (slot?.occupied_container_id && Number(slot.occupied_container_id)!==Number(container.id)) reasons.push('Location is already occupied.');
  if (slot?.reserved_task_id && Number(slot.reserved_task_id)!==Number(options.taskId||0)) reasons.push('Location is reserved by another task.');
  const allowed=typeof slot?.allowed_types==='string'?(()=>{try{return JSON.parse(slot.allowed_types)}catch{return []}})():slot?.allowed_types;
  if (Array.isArray(allowed)&&allowed.length&&!allowed.some(v=>String(v).toUpperCase()===String(container.iso_size).toUpperCase())) reasons.push(`Container type ${container.iso_size} is not in this location's allowed types.`);
  const size=String(container.iso_size||'');
  const length=size[0]==='2'?6.1:(size[0]==='4'||size[0]==='L')?12.3:null;
  const height=size[1]==='5'?2.9:2.6;
  if (length&&Number(slot?.length_m)>0&&Number(slot.length_m)<length) reasons.push(`Location length ${slot.length_m} m is too short for this container.`);
  if (Number(slot?.width_m)>0&&Number(slot.width_m)<2.44) reasons.push(`Location width ${slot.width_m} m is too narrow for a standard container.`);
  if (Number(slot?.height_m)>0&&Number(slot.height_m)<height) reasons.push(`Location height ${slot.height_m} m is too low for this container type.`);
  const grouping=String(container.cargo_classification||container.direction||'').toUpperCase();
  if(!options.allowOperationalGroupOverride&&slot?.operational_group&&grouping&&slot.operational_group.toUpperCase()!==grouping)reasons.push(`Location is restricted to ${slot.operational_group} operations.`);
  const maxWeight=Number(slot?.max_weight_kg||slot?.capacity_kg||0);
  if (maxWeight>0&&Number(container.weight_kg)>maxWeight) reasons.push(`Container weight exceeds the location limit of ${maxWeight} kg.`);
  if (size[0]==='4'&&Number(slot?.length_m)>0&&Number(slot.length_m)<length) reasons.push('40-foot container does not fit this location.');
  const maxTier=Math.max(1,Number(slot?.max_stack_tier||rules.maxStackTier||1));
  if (Number(slot?.tier)>maxTier) reasons.push(`Tier ${slot.tier} exceeds the approved maximum of ${maxTier}.`);
  if (Number(slot?.tier)>1) {
    if (container.cargo_status==='LOADED'&&!Number(container.weight_kg)) reasons.push('Loaded container has no weight; elevated placement is not recommended.');
    const [supports]=await connection.query('SELECT tier,occupied_container_id FROM yard_locations WHERE depot_code=? AND block_code=? AND row_code=? AND bay_code=? AND position_code=? AND tier<?',[slot.depot_code,slot.block_code,slot.row_code,slot.bay_code,slot.position_code,slot.tier]);
    if (supports.length!==Number(slot.tier)-1||supports.some((support,i)=>Number(support.tier)!==i+1||!support.occupied_container_id)) reasons.push('All supporting lower tiers must be occupied; gaps are not allowed.');
  }
  const zones=rules.holdZoneMap||{};
  const holdZone=container.hold_status&&container.hold_status!=='CLEAR'?zones[container.hold_status]:null;
  if (container.hold_status&&container.hold_status!=='CLEAR'&&(!holdZone||slot?.storage_zone!==holdZone)) reasons.push(`Active ${container.hold_status} hold requires an approved ${holdZone||'configured'} storage zone.`);
  if ((!container.hold_status||container.hold_status==='CLEAR')&&slot?.storage_zone&&Object.values(zones).includes(slot.storage_zone)) reasons.push('This storage zone is reserved for a specific hold category.');
  if (slot?.handling_access==='RESTRICTED'&&!container.assigned_equipment) reasons.push('Restricted handling access requires an equipment assignment.');
  return {eligible:reasons.length===0,reasons,maxTier};
}

app.get('/api/yard/recommendations',requirePermission('yard:plan'),async(req,res,next)=>{
  try{
    const containerId=Number(req.query.container_id);if(!containerId)return res.status(400).json({error:'Select a container to generate recommendations.'});
    const [[container]]=await pool.query(`SELECT c.*,(SELECT MIN(mc.expected_departure_at) FROM manifest_containers mc WHERE mc.container_id=c.id AND mc.status='EXPECTED') expected_departure_at FROM containers c WHERE c.id=?`,[containerId]);if(!container)return res.status(404).json({error:'Container not found.'});
    container.assigned_equipment=String(req.query.assigned_equipment||'').trim()||null;
    const [rawRules]=await pool.query("SELECT rule_code,value_json FROM operational_rules WHERE is_active=1 AND rule_code IN ('yard_max_stack_tier','yard_allocation_weights','yard_hold_zone_map')");
    const parsed=Object.fromEntries(rawRules.map(r=>[r.rule_code,typeof r.value_json==='string'?JSON.parse(r.value_json):r.value_json]));
    const rules={maxStackTier:Number(parsed.yard_max_stack_tier)||1,weights:parsed.yard_allocation_weights||{tier:10,same_block:8,access:4},holdZoneMap:parsed.yard_hold_zone_map||{}};
    const depotCode=req.query.depot_code||null;
    const [slots]=await pool.query(`SELECT l.* FROM yard_locations l WHERE (? IS NULL OR l.depot_code=?) ORDER BY l.depot_code,l.block_code,l.row_code,l.bay_code,l.tier,l.position_code`,[depotCode,depotCode]);
    const result=[];const rejected={};
    for(const slot of slots){const check=await checkSlotCompatibility(pool,container,slot,rules);if(!check.eligible){for(const reason of check.reasons)rejected[reason]=(rejected[reason]||0)+1;continue;}
      const source=slots.find(x=>Number(x.id)===Number(container.current_location_id));const dwellHours=container.expected_departure_at?Math.max(0,(new Date(container.expected_departure_at).getTime()-Date.now())/3600000):null;const shortDwell=dwellHours!==null&&dwellHours<72;
      const tierScore=Number(rules.weights.tier||10)*(shortDwell?Math.max(1,check.maxTier+1-Number(slot.tier)):Number(slot.tier));const sameBlock=container.current_location_id&&slot.block_code===(source||{}).block_code?1:0;const accessScore=Number(rules.weights.access||4)*(slot.handling_access==='EASY'?1:0);const distanceScore=shortDwell?-Number(rules.weights.gate_distance||0)*Number(slot.gate_distance_m||0):0;
      const score=tierScore+Number(rules.weights.same_block||8)*sameBlock+accessScore+distanceScore;
      const reasons=[`Compatible with ${container.iso_size}.`,`Tier ${slot.tier} is within approved max ${check.maxTier}.`,shortDwell?'Lower tier prioritized for expected short dwell and fewer rehandles.':'Expected dwell is long or unknown; higher accessible tier is preferred when compatible.'];if(sameBlock)reasons.push('Same block as current location to reduce rehandles.');if(slot.gate_distance_m&&shortDwell)reasons.push(`Gate access distance ${slot.gate_distance_m} m prioritizes quicker retrieval.`);if(slot.operational_group)reasons.push(`Matches ${slot.operational_group} operational grouping.`);if(slot.max_weight_kg&&container.weight_kg)reasons.push(`Weight ${container.weight_kg} kg is within the ${slot.max_weight_kg} kg limit.`);if(slot.storage_zone&&container.hold_status!=='CLEAR')reasons.push(`Matches approved ${container.hold_status} zone.`);if(slot.handling_access)reasons.push(`${slot.handling_access} handling access${slot.handling_access==='RESTRICTED'?' · assigned equipment required':''}.`);
      result.push({...slot,score,reasons});
    }
    result.sort((a,b)=>b.score-a.score||a.location_code.localeCompare(b.location_code));
    res.json({container:{id:container.id,container_number:container.container_number,iso_size:container.iso_size,cargo_status:container.cargo_status,weight_kg:container.weight_kg,hold_status:container.hold_status},rules,eligible_count:result.length,rejected,recommendations:result.slice(0,30)});
  }catch(error){next(error);}
});

app.get('/api/audit', requirePermission('audit:read'), async (req,res,next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100,1),500);
    const [rows] = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit]);
    res.json(rows);
  } catch(error) { next(error); }
});

app.post('/api/containers/:id/hold', requirePermission('holds:write'), async (req,res,next) => {
  const { hold_status, reason } = req.body;
  const inspected_by = req.user.email;
  const allowed = ['CUSTOMS','COMMERCIAL','SECURITY','INSPECTION','DOCUMENTATION','DAMAGE'];
  if (!allowed.includes(hold_status) || !reason?.trim()) return res.status(400).json({error:'Choose a valid hold type and provide a reason.'});
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[container]] = await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[req.params.id]);
    if (!container) { await connection.rollback(); return res.status(404).json({error:'Container not found.'}); }
    if (container.status === 'GATED_OUT') { await connection.rollback(); return res.status(409).json({error:'Cannot hold a container that has left the depot.'}); }
    await connection.query("UPDATE containers SET hold_status=?,hold_reason=?,status='ON_HOLD' WHERE id=?",[hold_status,reason.trim(),container.id]);
    const [inspection] = await connection.query(`INSERT INTO inspections (container_id,inspection_type,result,hold_type,hold_reason,inspected_by) VALUES (?,'HOLD','HOLD',?,?,?)`,[container.id,hold_status,reason.trim(),inspected_by]);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'HOLD','CONTAINER',String(container.id),reason.trim(),JSON.stringify({hold_status:container.hold_status,status:container.status}),JSON.stringify({hold_status,status:'ON_HOLD',inspection_id:inspection.insertId})]);
    await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,'Current location',?,?)`,[container.id,container.container_number,'HOLD',inspected_by,reason.trim()]);
    await connection.commit();
    res.status(201).json({status:'ON_HOLD',hold_status,inspection_id:inspection.insertId});
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.post('/api/containers/:id/release-hold', requirePermission('holds:release'), async (req,res,next) => {
  const { release_authority, reason } = req.body;
  if (!release_authority?.trim() || !reason?.trim()) return res.status(400).json({error:'Release authority and release reason are required.'});
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[container]] = await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[req.params.id]);
    if (!container) { await connection.rollback(); return res.status(404).json({error:'Container not found.'}); }
    if (container.hold_status === 'CLEAR') { await connection.rollback(); return res.status(409).json({error:'Container has no active hold.'}); }
    await connection.query("UPDATE containers SET hold_status='CLEAR',hold_reason=NULL,status=IF(current_location_id IS NULL,'READY_OUT','IN_YARD') WHERE id=?",[container.id]);
    await connection.query("UPDATE inspections SET result='PASS',release_authority=?,released_at=NOW() WHERE container_id=? AND result='HOLD' AND released_at IS NULL ORDER BY inspected_at DESC LIMIT 1",[release_authority.trim(),container.id]);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'RELEASE_HOLD','CONTAINER',String(container.id),reason.trim(),JSON.stringify({hold_status:container.hold_status,hold_reason:container.hold_reason}),JSON.stringify({hold_status:'CLEAR',release_authority:release_authority.trim()})]);
    await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,'Current location',?,?)`,[container.id,container.container_number,'RELEASE_HOLD',req.user.email,reason.trim()]);
    await connection.commit();
    res.json({hold_status:'CLEAR'});
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.post('/api/containers/:id/inspections',requirePermission('inspections:write'),async(req,res,next)=>{
  const {inspection_type,result,condition_status,damage_category,condition_notes,seal_condition,hold_type,hold_reason,follow_up,visit_id,evidence_refs=[]}=req.body;
  if(!inspection_type||!['PASS','DAMAGE','HOLD','REVIEW'].includes(result))return res.status(400).json({error:'Inspection type and a valid result are required.'});
  if(condition_status&&!['UNKNOWN','GOOD','DAMAGED','UNCHECKED'].includes(condition_status))return res.status(400).json({error:'Container condition is not a supported value.'});
  if(result==='HOLD'&&!['CUSTOMS','COMMERCIAL','SECURITY','INSPECTION','DOCUMENTATION','DAMAGE'].includes(hold_type))return res.status(400).json({error:'Choose a supported hold category.'});
  if(result==='HOLD'&&(!hold_type||!String(hold_reason||'').trim()))return res.status(400).json({error:'A hold category and reason are required for a HOLD result.'});
  if(!Array.isArray(evidence_refs)||evidence_refs.length>10)return res.status(400).json({error:'Evidence must be an array of up to 10 HTTPS file references.'});
  for(const value of evidence_refs){try{const uri=new URL(String(value));if(uri.protocol!=='https:')return res.status(400).json({error:'Inspection evidence references must use HTTPS.'});}catch{return res.status(400).json({error:'An inspection evidence reference is not a valid HTTPS URL.'});}}
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();const [[container]]=await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[req.params.id]);if(!container){await connection.rollback();return res.status(404).json({error:'Container not found.'});}
    if(visit_id){const [[visit]]=await connection.query('SELECT id FROM visits WHERE id=? AND container_id=? FOR UPDATE',[visit_id,container.id]);if(!visit){await connection.rollback();return res.status(400).json({error:'Selected gate visit does not belong to this container.'});}}
    const [created]=await connection.query(`INSERT INTO inspections(container_id,visit_id,inspection_type,result,condition_notes,damage_category,seal_condition,hold_type,hold_reason,follow_up,evidence_refs,inspected_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[container.id,visit_id||null,String(inspection_type).slice(0,40),result,String(condition_notes||'').slice(0,4000)||null,String(damage_category||'').slice(0,80)||null,String(seal_condition||'').slice(0,120)||null,result==='HOLD'?hold_type:null,result==='HOLD'?String(hold_reason).slice(0,255):null,String(follow_up||'').slice(0,500)||null,JSON.stringify(evidence_refs),req.user.email]);
    if(result==='HOLD')await connection.query("UPDATE containers SET inspection_status='HOLD',hold_status=?,hold_reason=?,status='ON_HOLD' WHERE id=?",[hold_type,String(hold_reason).trim(),container.id]);
    else await connection.query('UPDATE containers SET inspection_status=?,condition_status=COALESCE(?,condition_status) WHERE id=?',[result==='PASS'?'PASSED':result,condition_status||null,container.id]);
    for(const [index,uri] of evidence_refs.entries())await connection.query('INSERT INTO container_documents(container_id,document_type,file_name,uri,content_type,uploaded_by) VALUES (?,?,?,?,?,?)',[container.id,'INSPECTION_EVIDENCE',`inspection-${created.insertId}-${index+1}`,uri,'image/*',req.user.email]);
    await connection.query('INSERT INTO movement_events(container_id,container_number,event_type,location_code,actor,reason,new_values) VALUES (?,?,?,?,?,?,?)',[container.id,container.container_number,'INSPECTION',null,req.user.email,condition_notes||`Inspection result ${result}`,JSON.stringify({inspection_id:created.insertId,result,damage_category,follow_up,evidence_count:evidence_refs.length})]);
    await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)',[req.user.email,req.user.role_name,'INSPECTION','CONTAINER',String(container.id),condition_notes||`Inspection result ${result}`,JSON.stringify({inspection_id:created.insertId,result,hold_type:result==='HOLD'?hold_type:null,visit_id:visit_id||null,evidence_count:evidence_refs.length})]);
    await connection.commit();res.status(201).json({id:created.insertId,result,hold_status:result==='HOLD'?hold_type:container.hold_status});
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});

app.post('/api/tasks', requirePermission('tasks:create'), async (req,res,next) => {
  const { container_id, task_type='PUTAWAY', priority='NORMAL', destination_location_id, depot_code=null, reason='Yard plan', assigned_operator=null, assigned_equipment=null, override_reason='', supervisor_email='' } = req.body;
  if (!container_id) return res.status(400).json({ error: 'Select a container.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[container]] = await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[container_id]);
    if (!container) { await connection.rollback(); return res.status(404).json({ error:'Container not found.' }); }
    container.assigned_equipment=assigned_equipment;
    if (container.hold_status !== 'CLEAR' && ['RETRIEVAL','RELOCATION','REHANDLE'].includes(task_type)) { await connection.rollback(); return res.status(409).json({ error:`Active ${container.hold_status} hold prevents this movement.` }); }
    if (task_type === 'PUTAWAY' && container.status !== 'GATE_IN') { await connection.rollback(); return res.status(409).json({ error:'Putaway requires a manifest-listed or approved-exception arrival recorded at the gate.' }); }
    if (assigned_operator) {
      const [[operator]] = await connection.query("SELECT id FROM users WHERE email=? AND role_name='Reach-Stacker Operator' AND is_active=1 FOR UPDATE",[assigned_operator]);
      if (!operator) { await connection.rollback(); return res.status(400).json({error:'Assigned operator must be an active Reach-Stacker Operator account.'}); }
    }
    const rules={maxStackTier:Number(await readRule(connection,'yard_max_stack_tier',1))||1,holdZoneMap:await readRule(connection,'yard_hold_zone_map',{}),weights:await readRule(connection,'yard_allocation_weights',{tier:10,same_block:8,access:4})};
    let destination=destination_location_id||null;let selectedSlot=null;let allocationOverride=null;
    if (!destination && ['PUTAWAY','RELOCATION','REHANDLE','YARD_CORRECTION'].includes(task_type)) {
      const requestedDepot=depot_code||null;
      const [candidates]=await connection.query(`SELECT * FROM yard_locations WHERE (? IS NULL OR depot_code=?) AND is_active=1 AND is_blocked=0 AND availability_status='AVAILABLE' AND occupied_container_id IS NULL AND reserved_task_id IS NULL ORDER BY block_code,row_code,bay_code,tier FOR UPDATE`,[requestedDepot,requestedDepot]);
      for(const candidate of candidates){const fit=await checkSlotCompatibility(connection,container,candidate,rules);if(fit.eligible){selectedSlot=candidate;destination=candidate.id;break;}}
      if(!destination){await connection.rollback();return res.status(409).json({error:'No eligible location was found. Review approved stack limits, holds, dimensions, weight and slot restrictions.'});}
    }
    if(destination){
      if(!selectedSlot){[[selectedSlot]]=await connection.query('SELECT * FROM yard_locations WHERE id=? FOR UPDATE',[destination]);}
      let fit=await checkSlotCompatibility(connection,container,selectedSlot,rules);
      if(!fit.eligible){
        const groupOnly=fit.reasons.length>0&&fit.reasons.every(x=>x.startsWith('Location is restricted to '));
        if(!groupOnly||!String(override_reason).trim()){await connection.rollback();return res.status(409).json({error:'Selected location is incompatible.',reasons:fit.reasons,override_available:groupOnly});}
        const requiresSupervisor=await readRule(connection,'yard_allocation_override_requires_supervisor',true);
        let approvedBy=null;
        if(requiresSupervisor){
          if(!String(supervisor_email).trim()||String(supervisor_email).toLowerCase()===req.user.email.toLowerCase()){await connection.rollback();return res.status(409).json({error:'A different authorised supervisor must approve this operational-group override.'});}
          const [[supervisor]]=await connection.query(`SELECT u.email FROM users u JOIN role_permissions rp ON rp.role_name=u.role_name AND rp.permission_code IN ('system:manage','manifest:approve') WHERE u.email=? AND u.is_active=1 GROUP BY u.id,u.email HAVING COUNT(DISTINCT rp.permission_code)>=1`,[String(supervisor_email).trim()]);
          if(!supervisor){await connection.rollback();return res.status(403).json({error:'Supervisor approval must come from an active user with system management or manifest approval permission.'});}
          approvedBy=supervisor.email;
        }else if(!req.user.permissions.includes('yard:plan')){await connection.rollback();return res.status(403).json({error:'Your role cannot approve an allocation override.'});}
        allocationOverride={reason:String(override_reason).trim(),approved_by:approvedBy};
        fit=await checkSlotCompatibility(connection,container,selectedSlot,rules,{allowOperationalGroupOverride:true});
      }
      if(!fit.eligible){await connection.rollback();return res.status(409).json({error:'Selected location still violates a physical, safety, weight, availability or hold-zone rule.',reasons:fit.reasons});}
      const [reserve]=await connection.query(`UPDATE yard_locations SET reserved_task_id=-1,reservation_expires_at=DATE_ADD(NOW(),INTERVAL ? MINUTE) WHERE id=? AND is_active=1 AND is_blocked=0 AND availability_status='AVAILABLE' AND occupied_container_id IS NULL AND reserved_task_id IS NULL`,[Number(await readRule(connection,'yard_reservation_minutes',120))||120,destination]);
      if(!reserve.affectedRows){await connection.rollback();return res.status(409).json({error:'The selected location was reserved by another request. Refresh and choose another.'});}
    }
    const taskStatus=assigned_operator?'ASSIGNED':'QUEUED';
    const [result] = await connection.query(`INSERT INTO movement_tasks (container_id,task_type,priority,status,source_location_id,destination_location_id,reason,assigned_operator,assigned_equipment,allocation_override_reason,allocation_override_approved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[container_id,task_type,priority,taskStatus,container.current_location_id,destination,reason,assigned_operator,assigned_equipment,allocationOverride?.reason||null,allocationOverride?.approved_by||null]);
    if (destination) await connection.query('UPDATE yard_locations SET reserved_task_id=? WHERE id=?',[result.insertId,destination]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[result.insertId,'CREATED',req.user.email,reason]);
    if(assigned_operator)await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[result.insertId,'ASSIGNED',req.user.email,`Assigned to ${assigned_operator}${assigned_equipment?` using ${assigned_equipment}`:''}.`]);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'CREATE','MOVEMENT_TASK',String(result.insertId),reason,JSON.stringify({container_id,task_type,priority,destination_location_id:destination,allocation_override:allocationOverride})]);
    if(allocationOverride){await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[result.insertId,'ALLOCATION_OVERRIDE',req.user.email,allocationOverride.reason]);if(allocationOverride.approved_by)await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[result.insertId,'OVERRIDE_APPROVED',allocationOverride.approved_by,`Approved operational-group override requested by ${req.user.email}.`]);}
    await connection.commit();
    res.status(201).json({ id:result.insertId,status:'QUEUED' });
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.patch('/api/tasks/:id/start', requirePermission('tasks:complete'), async(req,res,next)=>{
  const connection=await pool.getConnection();try{
    await connection.beginTransaction();const [[task]]=await connection.query('SELECT * FROM movement_tasks WHERE id=? FOR UPDATE',[req.params.id]);
    if(!task){await connection.rollback();return res.status(404).json({error:'Task not found.'});}
    if(req.user.role_name==='Reach-Stacker Operator'&&task.assigned_operator!==req.user.email){await connection.rollback();return res.status(403).json({error:'You can only start a task assigned to your account.'});}
    if(!['QUEUED','ASSIGNED'].includes(task.status)){await connection.rollback();return res.status(409).json({error:`Task cannot start from ${task.status}.`});}
    await connection.query("UPDATE movement_tasks SET status='IN_PROGRESS',started_at=COALESCE(started_at,NOW()) WHERE id=?",[task.id]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'STARTED',req.user.email,'Operator started assigned yard task.']);
    await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,new_values) VALUES (?,?,?,?,?,?)',[req.user.email,req.user.role_name,'START','MOVEMENT_TASK',String(task.id),JSON.stringify({status:'IN_PROGRESS'})]);
    await connection.commit();res.json({status:'IN_PROGRESS'});
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});

app.patch('/api/tasks/:id/pickup', requirePermission('tasks:complete'), async(req,res,next)=>{
  const scanned=String(req.body.scanned_container_number||'').toUpperCase().replace(/\s+/g,'');const connection=await pool.getConnection();try{
    await connection.beginTransaction();const [[task]]=await connection.query('SELECT t.*,c.container_number,c.hold_status FROM movement_tasks t JOIN containers c ON c.id=t.container_id WHERE t.id=? FOR UPDATE',[req.params.id]);
    if(!task){await connection.rollback();return res.status(404).json({error:'Task not found.'});}
    if(req.user.role_name==='Reach-Stacker Operator'&&task.assigned_operator!==req.user.email){await connection.rollback();return res.status(403).json({error:'You can only confirm pickup for your assigned task.'});}
    if(task.status==='PICKUP_CONFIRMED'){await connection.rollback();return res.status(409).json({error:'Pickup has already been confirmed.'});}
    if(task.status!=='IN_PROGRESS'){await connection.rollback();return res.status(409).json({error:'Start this task before confirming pickup.'});}
    if(scanned!==String(task.container_number).replace(/\s+/g,'').toUpperCase()){await connection.rollback();return res.status(409).json({error:'Scanned container does not match the task container.'});}
    if(task.hold_status!=='CLEAR'){await connection.rollback();return res.status(409).json({error:`Active ${task.hold_status} hold prevents pickup.`});}
    if(task.source_location_id){const [[source]]=await connection.query('SELECT occupied_container_id FROM yard_locations WHERE id=? FOR UPDATE',[task.source_location_id]);if(!source||Number(source.occupied_container_id)!==Number(task.container_id)){await connection.rollback();return res.status(409).json({error:'Source location does not confirm the assigned container. Reconcile before pickup.'});}}
    await connection.query("UPDATE movement_tasks SET status='PICKUP_CONFIRMED',picked_up_at=NOW(),pickup_confirmed_by=? WHERE id=?",[req.user.email,task.id]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'PICKUP_CONFIRMED',req.user.email,`Container ${task.container_number} scan confirmed.`]);
    await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,new_values) VALUES (?,?,?,?,?,?)',[req.user.email,req.user.role_name,'PICKUP_CONFIRM','MOVEMENT_TASK',String(task.id),JSON.stringify({container_number:task.container_number,source_location_id:task.source_location_id})]);
    await connection.commit();res.json({status:'PICKUP_CONFIRMED'});
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});

app.patch('/api/tasks/:id/exception', requirePermission('tasks:complete'), async(req,res,next)=>{
  const reason=String(req.body.reason||'').trim();if(!reason)return res.status(400).json({error:'Exception reason is required.'});const connection=await pool.getConnection();try{
    await connection.beginTransaction();const [[task]]=await connection.query('SELECT * FROM movement_tasks WHERE id=? FOR UPDATE',[req.params.id]);if(!task){await connection.rollback();return res.status(404).json({error:'Task not found.'});}
    if(req.user.role_name==='Reach-Stacker Operator'&&task.assigned_operator!==req.user.email){await connection.rollback();return res.status(403).json({error:'You can only report an exception for your assigned task.'});}
    if(['COMPLETED','CANCELLED'].includes(task.status)){await connection.rollback();return res.status(409).json({error:`A ${task.status.toLowerCase()} task cannot be changed.`});}
    await connection.query("UPDATE movement_tasks SET status='EXCEPTION',exception_reason=? WHERE id=?",[reason,task.id]);
    if(task.status!=='PICKUP_CONFIRMED'&&task.destination_location_id)await connection.query('UPDATE yard_locations SET reserved_task_id=NULL,reservation_expires_at=NULL WHERE id=? AND reserved_task_id=?',[task.destination_location_id,task.id]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'EXCEPTION',req.user.email,reason]);
    await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)',[req.user.email,req.user.role_name,'EXCEPTION','MOVEMENT_TASK',String(task.id),reason,JSON.stringify({status:task.status}),JSON.stringify({status:'EXCEPTION',exception_reason:reason})]);
    await connection.commit();res.json({status:'EXCEPTION'});
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});

app.patch('/api/tasks/:id/cancel', requirePermission('tasks:create'), async(req,res,next)=>{
  const reason=String(req.body.reason||'Cancelled by planner').trim();const connection=await pool.getConnection();try{
    await connection.beginTransaction();const [[task]]=await connection.query('SELECT * FROM movement_tasks WHERE id=? FOR UPDATE',[req.params.id]);if(!task){await connection.rollback();return res.status(404).json({error:'Task not found.'});}
    if(!['QUEUED','ASSIGNED'].includes(task.status)){await connection.rollback();return res.status(409).json({error:'A task can only be cancelled before it starts.'});}
    await connection.query("UPDATE movement_tasks SET status='CANCELLED',exception_reason=? WHERE id=?",[reason,task.id]);if(task.destination_location_id)await connection.query('UPDATE yard_locations SET reserved_task_id=NULL,reservation_expires_at=NULL WHERE id=? AND reserved_task_id=?',[task.destination_location_id,task.id]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'CANCELLED',req.user.email,reason]);await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)',[req.user.email,req.user.role_name,'CANCEL','MOVEMENT_TASK',String(task.id),reason,JSON.stringify({status:task.status}),JSON.stringify({status:'CANCELLED'})]);await connection.commit();res.json({status:'CANCELLED'});
  }catch(error){await connection.rollback();next(error);}finally{connection.release();}
});

app.patch('/api/tasks/:id/complete', requirePermission('tasks:complete'), async (req,res,next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[task]] = await connection.query('SELECT * FROM movement_tasks WHERE id=? FOR UPDATE',[req.params.id]);
    if (!task) { await connection.rollback(); return res.status(404).json({ error:'Task not found.' }); }
    if (req.user.role_name === 'Reach-Stacker Operator' && task.assigned_operator !== req.user.email) { await connection.rollback(); return res.status(403).json({error:'Operators can only confirm tasks assigned to their account.'}); }
    if (task.status === 'COMPLETED') { await connection.rollback(); return res.status(409).json({ error:'Task already completed.' }); }
    if (task.status !== 'PICKUP_CONFIRMED') { await connection.rollback(); return res.status(409).json({ error:'Confirm and scan the task pickup before confirming its drop.' }); }
    const actual = Number(req.body.actual_destination_location_id || task.destination_location_id);
    if (!actual && task.task_type !== 'RETRIEVAL') { await connection.rollback(); return res.status(400).json({ error:'Confirm the actual drop location.' }); }
    if (actual) {
      const [[slot]] = await connection.query('SELECT * FROM yard_locations WHERE id=? FOR UPDATE',[actual]);
      if (!slot || !slot.is_active || slot.is_blocked || (slot.availability_status&&slot.availability_status!=='AVAILABLE') || (slot.occupied_container_id && slot.occupied_container_id !== task.container_id)) { await connection.rollback(); return res.status(409).json({ error:'Actual destination is inactive, blocked or occupied.' }); }
      const [[containerForFit]]=await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[task.container_id]);
      const fitRules={maxStackTier:Number(await readRule(connection,'yard_max_stack_tier',1))||1,holdZoneMap:await readRule(connection,'yard_hold_zone_map',{})};
      const actualFit=await checkSlotCompatibility(connection,containerForFit,slot,fitRules,{taskId:task.id,allowOperationalGroupOverride:Boolean(task.allocation_override_reason)&&actual===Number(task.destination_location_id)});
      if(!actualFit.eligible){await connection.rollback();return res.status(409).json({error:'Actual destination does not meet allocation rules.',reasons:actualFit.reasons});}
      if (task.destination_location_id && actual !== task.destination_location_id) {
        const fit=await checkSlotCompatibility(connection,containerForFit,slot,fitRules);
        if(!fit.eligible){await connection.rollback();return res.status(409).json({error:'Unexpected destination is incompatible.',reasons:fit.reasons});}
        await connection.query("UPDATE movement_tasks SET status='AWAITING_APPROVAL',actual_destination_location_id=?,exception_reason='Operator reported an unplanned but compatible drop location.' WHERE id=?",[actual,task.id]);
        if(task.destination_location_id)await connection.query('UPDATE yard_locations SET reserved_task_id=NULL,reservation_expires_at=NULL WHERE id=? AND reserved_task_id=?',[task.destination_location_id,task.id]);
        const [[cont]]=await connection.query('SELECT container_number FROM containers WHERE id=?',[task.container_id]);
        await connection.query("INSERT INTO reconciliation_discrepancies(container_id,container_number,category,description) VALUES (?,?,'UNPLANNED_DROP',?)",[task.container_id,cont.container_number,`Task ${task.id} drop at ${slot.location_code} differs from planned destination. Supervisor approval is required before inventory changes.`]);
        await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'AWAITING_APPROVAL',req.user.email,`Unplanned drop at ${slot.location_code}; inventory was not changed.`]);
        await connection.query('INSERT INTO audit_log(actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)',[req.user.email,req.user.role_name,'UNPLANNED_DROP','MOVEMENT_TASK',String(task.id),'Unexpected drop; approval required',JSON.stringify({planned:task.destination_location_id,actual,inventory_updated:false})]);
        await connection.commit();return res.status(202).json({status:'AWAITING_APPROVAL',message:'Unexpected drop recorded. Inventory remains unchanged until an authorised reconciliation.'});
      }
      if (task.destination_location_id && slot.reserved_task_id !== task.id) { await connection.rollback(); return res.status(409).json({error:'The task no longer owns the destination slot reservation.'}); }
      if (task.source_location_id) await connection.query('UPDATE yard_locations SET occupied_container_id=NULL WHERE id=? AND occupied_container_id=?',[task.source_location_id,task.container_id]);
      await connection.query('UPDATE yard_locations SET occupied_container_id=?,reserved_task_id=NULL,reservation_expires_at=NULL WHERE id=?',[task.container_id,actual]);
      await connection.query("UPDATE containers SET current_location_id=?,status='IN_YARD',yard_in_at=COALESCE(yard_in_at,NOW()) WHERE id=?",[actual,task.container_id]);
      const [[loc]] = await connection.query('SELECT location_code FROM yard_locations WHERE id=?',[actual]);
      const [[cont]] = await connection.query('SELECT container_number FROM containers WHERE id=?',[task.container_id]);
      await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,?,?,?)`,[task.container_id,cont.container_number,task.task_type,loc.location_code,req.user.email,task.reason]);
    } else {
      if (task.source_location_id) await connection.query('UPDATE yard_locations SET occupied_container_id=NULL WHERE id=? AND occupied_container_id=?',[task.source_location_id,task.container_id]);
      await connection.query("UPDATE containers SET status='READY_OUT',current_location_id=NULL WHERE id=?",[task.container_id]);
      const [[cont]] = await connection.query('SELECT container_number FROM containers WHERE id=?',[task.container_id]);
      await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,'Gate lane',?,'Retrieval completed')`,[task.container_id,cont.container_number,'RETRIEVAL',req.user.email]);
    }
    await connection.query("UPDATE movement_tasks SET status='COMPLETED',completed_at=NOW(),actual_destination_location_id=? WHERE id=?",[actual,task.id]);
    await connection.query('INSERT INTO movement_task_events(task_id,event_type,actor,detail) VALUES (?,?,?,?)',[task.id,'COMPLETED',req.user.email,`Actual destination: ${actual||'Gate lane'}.`]);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'COMPLETE','MOVEMENT_TASK',String(task.id),task.reason,JSON.stringify({status:task.status,source_location_id:task.source_location_id}),JSON.stringify({status:'COMPLETED',actual_destination_location_id:actual})]);
    await connection.commit(); res.json({ status:'COMPLETED' });
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.post('/api/visits/gate-in', requirePermission('gate:in'), async (req,res,next) => {
  const { container_id, truck_registration, driver_name, manifest_ref, seal_number, exception_id } = req.body;
  if (!container_id || !truck_registration) return res.status(400).json({ error:'Container and truck registration are required.' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[container]] = await connection.query('SELECT * FROM containers WHERE id=? FOR UPDATE',[container_id]);
    if (!container) { await connection.rollback(); return res.status(404).json({error:'Container not found.'}); }
    if (container.current_location_id) { await connection.rollback(); return res.status(409).json({error:'Container is already assigned to a confirmed yard location.'}); }
    const [[openVisit]] = await connection.query("SELECT id FROM visits WHERE container_id=? AND status='OPEN' FOR UPDATE",[container_id]);
    if (openVisit) { await connection.rollback(); return res.status(409).json({ error:'An active gate visit already exists for this container.' }); }
    const [[manifestLine]] = await connection.query(`SELECT mc.id,mc.manifest_id FROM manifest_containers mc JOIN manifests m ON m.id=mc.manifest_id WHERE mc.status='EXPECTED' AND m.status<>'CANCELLED' AND (mc.container_id=? OR mc.container_number=?) ORDER BY mc.id DESC LIMIT 1 FOR UPDATE`,[container_id,container.container_number]);
    let approvedException=null;
    if(!manifestLine){
      if(exception_id){[[approvedException]]=await connection.query("SELECT e.id,e.manifest_id FROM manifest_exceptions e LEFT JOIN manifests m ON m.id=e.manifest_id WHERE e.id=? AND e.container_id=? AND e.status='APPROVED' AND e.visit_id IS NULL AND (e.manifest_id IS NULL OR m.status<>'CANCELLED') FOR UPDATE",[exception_id,container_id]);}
      else{[[approvedException]]=await connection.query("SELECT e.id,e.manifest_id FROM manifest_exceptions e LEFT JOIN manifests m ON m.id=e.manifest_id WHERE e.container_id=? AND e.status='APPROVED' AND e.visit_id IS NULL AND (e.manifest_id IS NULL OR m.status<>'CANCELLED') ORDER BY e.reviewed_at DESC LIMIT 1 FOR UPDATE",[container_id]);}
      if(!approvedException){await connection.rollback();return res.status(409).json({error:'Container is not on an approved manifest. Request and receive an approved unexpected-arrival exception before gate-in; no arrival or yard allocation was recorded.'});}
    }
    const manifestId=manifestLine?.manifest_id||approvedException?.manifest_id||null;
    const [result] = await connection.query(`INSERT INTO visits (container_id,direction,truck_registration,driver_name,manifest_ref,seal_number,manifest_id,exception_id,gate_in_at,status) VALUES (?,'IN',?,?,?,?,?,?,NOW(),'OPEN')`,[container_id,truck_registration,driver_name || null,manifest_ref || container.manifest_ref || null,seal_number || null,manifestId,approvedException?.id||null]);
    await connection.query("UPDATE containers SET status='GATE_IN',yard_in_at=NOW(),last_movement_at=NOW(),seal_number=COALESCE(?,seal_number),manifest_ref=COALESCE(?,manifest_ref) WHERE id=?",[seal_number || null,manifest_ref||null,container_id]);
    if(manifestLine){await connection.query("UPDATE manifest_containers SET container_id=?,status='RECEIVED' WHERE id=?",[container_id,manifestLine.id]);await connection.query("UPDATE manifests SET status=IF((SELECT COUNT(*) FROM manifest_containers WHERE manifest_id=? AND status='EXPECTED')=0,'RECEIVED','PARTIALLY_RECEIVED') WHERE id=?",[manifestId,manifestId]);}
    if(approvedException)await connection.query('UPDATE manifest_exceptions SET visit_id=? WHERE id=?',[result.insertId,approvedException.id]);
    await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,'Gate lane',?,?)`,[container_id,container.container_number,'GATE_IN',req.user.email,'Inbound arrival']);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'GATE_IN','VISIT',String(result.insertId),'Inbound arrival',JSON.stringify({container_id,truck_registration,driver_name,manifest_ref})]);
    await connection.commit();
    res.status(201).json({ id:result.insertId,status:'OPEN' });
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.post('/api/visits/:id/gate-out', requirePermission('gate:out'), async (req,res,next) => {
  const releaseReference=String(req.body.release_reference||'').trim();const handoverEvidence=String(req.body.handover_evidence||'').trim();
  if(!releaseReference)return res.status(400).json({error:'An authorised release/order reference is required for gate-out.'});
  if(handoverEvidence){try{const uri=new URL(handoverEvidence);if(uri.protocol!=='https:')return res.status(400).json({error:'Handover evidence must be an HTTPS reference.'});}catch{return res.status(400).json({error:'Handover evidence must be a valid HTTPS reference.'});}}
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[visit]] = await connection.query(`SELECT v.*,c.hold_status,c.container_number,c.current_location_id,c.booking_ref,c.customs_status,c.commercial_status FROM visits v JOIN containers c ON c.id=v.container_id WHERE v.id=? FOR UPDATE`,[req.params.id]);
    if (!visit) { await connection.rollback(); return res.status(404).json({ error:'Visit not found.' }); }
    if (visit.status !== 'OPEN') { await connection.rollback(); return res.status(409).json({error:'Visit is already closed.'}); }
    if (visit.hold_status !== 'CLEAR') { await connection.rollback(); return res.status(409).json({ error:'Active hold prevents gate-out.' }); }
    if (visit.current_location_id) { await connection.rollback(); return res.status(409).json({error:'Container is still assigned to a yard slot. Complete a retrieval task before gate-out.'}); }
    if(!visit.booking_ref&&!visit.manifest_ref){await connection.rollback();return res.status(409).json({error:'A booking, order, or manifest reference must be recorded before gate-out.'});}
    const requireClearance=await readRule(connection,'gateout_require_clearance',false);if(requireClearance&&(visit.customs_status!=='CLEAR'||visit.commercial_status!=='CLEAR')){await connection.rollback();return res.status(409).json({error:'Customs and commercial status must both be CLEAR before gate-out.'});}
    const requireDocument=await readRule(connection,'gateout_require_documents',false);if(requireDocument){const [[docs]]=await connection.query('SELECT COUNT(*) count FROM container_documents WHERE container_id=?',[visit.container_id]);if(Number(docs.count)<1){await connection.rollback();return res.status(409).json({error:'A required release document must be linked to the container before gate-out.'});}}
    const receiptReference=`YMS-OUT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${visit.id}`;
    const [closed] = await connection.query("UPDATE visits SET gate_out_at=NOW(),status='CLOSED',gate_out_reference=?,handover_evidence=?,receipt_reference=? WHERE id=? AND status='OPEN'",[releaseReference,handoverEvidence||null,receiptReference,req.params.id]);
    if (!closed.affectedRows) { await connection.rollback(); return res.status(409).json({error:'Visit is no longer open.'}); }
    await connection.query("UPDATE containers SET status='GATED_OUT',last_movement_at=NOW() WHERE id=?",[visit.container_id]);
    await connection.query(`INSERT INTO movement_events (container_id,container_number,event_type,location_code,actor,reason) VALUES (?,?,?,'Gate lane',?,'Outbound gate confirmation')`,[visit.container_id,visit.container_number,'GATE_OUT',req.user.email]);
    await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)`,[req.user.email,req.user.role_name,'GATE_OUT','VISIT',String(visit.id),'Outbound gate confirmation',JSON.stringify({status:'OPEN'}),JSON.stringify({status:'CLOSED',container_id:visit.container_id})]);
    await connection.commit();
    res.json({ status:'CLOSED',receipt_reference:receiptReference,release_reference:releaseReference });
  } catch(error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.use((error,_req,res,_next) => { console.error(error); res.status(500).json({ error:'The request could not be completed.', code:error.code || 'INTERNAL_ERROR' }); });
const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`ICD YMS API listening on http://localhost:${port}`));

