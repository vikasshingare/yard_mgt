import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

const palette = { ink:'#192a3a', muted:'#71808c', line:'#e8edf0', teal:'#0d8b78', mint:'#e4f4f0', orange:'#df8d42', paleOrange:'#fff2e4', red:'#c84b4b', paleRed:'#fbeaea', blue:'#4386c5', paleBlue:'#eaf2fb', white:'#fff', paper:'#f8fafb' };
const types = [
  { id:'PUTAWAY', label:'Putaway', hint:'Move a gate-in container into the yard', icon:'↓' },
  { id:'RETRIEVAL', label:'Retrieval', hint:'Bring a container from the yard to the gate', icon:'↑' },
  { id:'RELOCATION', label:'Relocation', hint:'Move a container to another yard slot', icon:'⇄' },
  { id:'REHANDLE', label:'Rehandle', hint:'Move a container to access another unit', icon:'↗' },
  { id:'YARD_CORRECTION', label:'Yard correction', hint:'Correct a confirmed yard placement', icon:'⌖' },
];

function Choice({ label, detail, selected, onPress, icon }:any) {
  return <Pressable onPress={onPress} style={{width:150,minHeight:74,flexGrow:1,flexBasis:138,padding:11,borderRadius:9,borderWidth:1,borderColor:selected?palette.teal:palette.line,backgroundColor:selected?palette.mint:palette.white,marginRight:8,marginBottom:8}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:8}}><View style={{width:25,height:25,borderRadius:7,backgroundColor:selected?palette.teal:'#eef2f4',alignItems:'center',justifyContent:'center'}}><Text style={{color:selected?palette.white:palette.muted,fontWeight:'800'}}>{icon}</Text></View><Text style={{fontSize:12,fontWeight:'800',color:palette.ink}}>{label}</Text></View>
    <Text style={{fontSize:10,color:palette.muted,lineHeight:14,marginTop:7}}>{detail}</Text>
  </Pressable>;
}

function Section({ title, hint, children }:any) {
  return <View style={{padding:15,backgroundColor:palette.white,borderWidth:1,borderColor:palette.line,borderRadius:10,marginBottom:12}}>
    <Text style={{fontSize:12,fontWeight:'800',color:palette.ink}}>{title}</Text>
    {hint&&<Text style={{fontSize:10,color:palette.muted,marginTop:4,marginBottom:11}}>{hint}</Text>}
    {children}
  </View>;
}

function Label({ children }:any) { return <Text style={{fontSize:10,fontWeight:'800',letterSpacing:.3,color:'#50616d',marginBottom:6}}>{children}</Text>; }
function Input({ label, value, onChangeText, placeholder }:any) {
  return <View style={{flex:1,minWidth:190,marginBottom:10}}><Label>{label}</Label><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder||`Enter ${label.toLowerCase()}`} placeholderTextColor="#9aa5ac" style={{minHeight:40,borderWidth:1,borderColor:palette.line,borderRadius:7,paddingHorizontal:11,paddingVertical:8,fontSize:12,color:palette.ink,backgroundColor:palette.white}} /></View>;
}
function Pill({ label, active, onPress, tone='teal' }:any) {
  const color=tone==='orange'?palette.orange:palette.teal;
  return <Pressable onPress={onPress} style={{paddingHorizontal:11,paddingVertical:8,borderRadius:7,borderWidth:1,borderColor:active?color:palette.line,backgroundColor:active?(tone==='orange'?palette.paleOrange:palette.mint):palette.white,marginRight:7,marginBottom:7}}><Text style={{fontSize:10,fontWeight:'800',color:active?color:palette.ink}}>{label}</Text></Pressable>;
}

export default function MoveTaskForm({ form, setForm, containers, operators, locations, onCancel, onCreate, saving=false, mobile=false }:any) {
  const [containerSearch,setContainerSearch]=useState('');
  const [locationSearch,setLocationSearch]=useState('');
  const taskType=form.task_type||'PUTAWAY';
  const selectedContainer=containers.find((c:any)=>Number(c.id)===Number(form.container_id));
  const eligibleContainers=useMemo(()=>containers.filter((c:any)=>{
    const valid=taskType==='PUTAWAY'?c.status==='GATE_IN':taskType==='YARD_CORRECTION'?Boolean(c.current_location_id||c.location_code):c.status!=='GATED_OUT'&&Boolean(c.current_location_id||c.location_code);
    return valid&&`${c.container_number} ${c.location_code||''} ${c.iso_size||''}`.toLowerCase().includes(containerSearch.toLowerCase());
  }),[containers,taskType,containerSearch]);
  const availableLocations=useMemo(()=>locations.filter((l:any)=>l.is_active&&!l.is_blocked&&l.availability_status==='AVAILABLE'&&!l.occupied_container_id&&(!l.reserved_task_id||Number(l.id)===Number(form.selected_destination_location_id))&&`${l.location_code} ${l.block_code} ${l.row_code} ${l.bay_code}`.toLowerCase().includes(locationSearch.toLowerCase())),[locations,form.selected_destination_location_id,locationSearch]);
  const field=(key:string,value:any)=>setForm({...form,[key]:value});
  const needsYardSlot=['PUTAWAY','RELOCATION','REHANDLE','YARD_CORRECTION'].includes(taskType);
  const selectedLocation=locations.find((l:any)=>Number(l.id)===Number(form.selected_destination_location_id));
  const taskColor=taskType==='RETRIEVAL'?palette.blue:taskType==='RELOCATION'?palette.orange:palette.teal;
  const taskBg=taskType==='RETRIEVAL'?palette.paleBlue:taskType==='RELOCATION'?palette.paleOrange:palette.mint;
  const ready=!!selectedContainer&&(!needsYardSlot||!!form.selected_destination_location_id);

  return <>
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator style={{maxHeight:mobile?460:560}} contentContainerStyle={{paddingBottom:8}}>
      <Section title="1 · Choose movement" hint="Select the operation. Available containers and destination slots update automatically.">
        <View style={{flexDirection:'row',flexWrap:'wrap'}}>{types.map(t=><Choice key={t.id} icon={t.icon} label={t.label} detail={t.hint} selected={taskType===t.id} onPress={()=>setForm({...form,task_type:t.id,container_id:'',selected_destination_location_id:''})}/>)}</View>
      </Section>
      <Section title="2 · Select container" hint={taskType==='PUTAWAY'?'Only approved gate-in containers can be assigned to putaway.':'Select a container currently confirmed in the yard.'}>
        <TextInput value={containerSearch} onChangeText={setContainerSearch} placeholder="Search container number or location" placeholderTextColor="#9aa5ac" style={{minHeight:40,borderWidth:1,borderColor:palette.line,borderRadius:7,paddingHorizontal:11,fontSize:12,color:palette.ink,marginBottom:9}} />
        {selectedContainer&&<View style={{padding:11,borderRadius:8,backgroundColor:palette.mint,borderWidth:1,borderColor:'#b7ddd3',marginBottom:8}}><Text style={{fontSize:12,fontWeight:'800',color:palette.ink}}>{selectedContainer.container_number} · {selectedContainer.iso_size||'Size not recorded'}</Text><Text style={{fontSize:10,color:palette.muted,marginTop:4}}>{selectedContainer.location_code||'Gate lane'} · {String(selectedContainer.status||'').replaceAll('_',' ')}</Text></View>}
        <ScrollView nestedScrollEnabled style={{maxHeight:eligibleContainers.length>3?150:undefined}}>{eligibleContainers.map((c:any)=><Pressable key={c.id} onPress={()=>field('container_id',c.id)} style={{padding:10,borderBottomWidth:1,borderBottomColor:palette.line,borderRadius:6,backgroundColor:Number(form.container_id)===Number(c.id)?palette.mint:palette.white,flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><View><Text style={{fontSize:11,fontWeight:'800',color:palette.ink}}>{c.container_number}</Text><Text style={{fontSize:10,color:palette.muted,marginTop:3}}>{c.location_code||'Gate lane'} · {c.iso_size||'Unknown size'} · {String(c.status||'').replaceAll('_',' ')}</Text></View><Text style={{color:Number(form.container_id)===Number(c.id)?palette.teal:palette.muted,fontWeight:'800'}}>{Number(form.container_id)===Number(c.id)?'✓':'Select'}</Text></Pressable>)}{eligibleContainers.length===0&&<Text style={{fontSize:11,color:palette.muted,padding:12,textAlign:'center'}}>{containerSearch?'No containers match that search.':taskType==='PUTAWAY'?'No approved gate-in containers are ready for putaway.':'No eligible yard containers are available for this movement.'}</Text>}</ScrollView>
      </Section>
      {needsYardSlot&&<Section title="3 · Plan destination" hint="Only active, available and unreserved locations are shown. The server performs the final compatibility and safety checks.">
        <TextInput value={locationSearch} onChangeText={setLocationSearch} placeholder="Search location code, block, row or bay" placeholderTextColor="#9aa5ac" style={{minHeight:40,borderWidth:1,borderColor:palette.line,borderRadius:7,paddingHorizontal:11,fontSize:12,color:palette.ink,marginBottom:9}} />
        {selectedLocation&&<View style={{padding:11,borderRadius:8,backgroundColor:palette.mint,borderWidth:1,borderColor:'#b7ddd3',marginBottom:8}}><Text style={{fontSize:12,fontWeight:'800',color:palette.ink}}>Destination · {selectedLocation.location_code}</Text><Text style={{fontSize:10,color:palette.muted,marginTop:4}}>Block {selectedLocation.block_code} · Row {selectedLocation.row_code} · Bay {selectedLocation.bay_code} · Tier {selectedLocation.tier}</Text></View>}
        <ScrollView nestedScrollEnabled style={{maxHeight:140}} contentContainerStyle={{flexDirection:'row',flexWrap:'wrap'}}>{availableLocations.slice(0,100).map((l:any)=><Pill key={l.id} label={`${l.location_code} · T${l.tier}`} active={Number(form.selected_destination_location_id)===Number(l.id)} onPress={()=>field('selected_destination_location_id',l.id)}/>)}</ScrollView>
        {availableLocations.length===0&&<Text style={{fontSize:11,color:palette.muted,paddingVertical:8}}>{locationSearch?'No available locations match that search.':'No eligible locations available. Refresh yard inventory or review slot restrictions.'}</Text>}
      </Section>}
      <Section title={`${needsYardSlot?'4':'3'} · Dispatch details`} hint="Assignments are optional; unassigned tasks remain visible in the planner queue.">
        {operators.length>0&&<><Label>Reach-stacker operator</Label><View style={{flexDirection:'row',flexWrap:'wrap',marginBottom:8}}><Pill label="Unassigned" active={!form.assigned_operator} onPress={()=>field('assigned_operator','')}/>{operators.map((operator:any)=><Pill key={operator.id} label={operator.display_name||operator.email} active={form.assigned_operator===operator.email} onPress={()=>field('assigned_operator',operator.email)}/>)}</View></>}
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}><Input label="Assigned equipment" value={form.assigned_equipment||''} onChangeText={(v:string)=>field('assigned_equipment',v)} placeholder="Equipment ID / reach stacker"/><Input label="Work reason / instructions" value={form.reason||''} onChangeText={(v:string)=>field('reason',v)} placeholder="Reason for this move"/></View>
        <Label>Priority</Label><View style={{flexDirection:'row',flexWrap:'wrap'}}>{['LOW','NORMAL','HIGH','URGENT'].map(p=><Pill key={p} label={p} active={(form.priority||'NORMAL')===p} tone={p==='URGENT'?'orange':'teal'} onPress={()=>field('priority',p)}/>)}</View>
      </Section>
      <Section title="Allocation override · optional" hint="Use only for an operational grouping restriction. The server never permits safety, capacity or hold rules to be bypassed.">
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}><Input label="Override reason" value={form.override_reason||''} onChangeText={(v:string)=>field('override_reason',v)} placeholder="Explain operational reason"/><Input label="Approving supervisor email" value={form.supervisor_email||''} onChangeText={(v:string)=>field('supervisor_email',v)} placeholder="Different authorised approver"/></View>
      </Section>
      <View style={{padding:12,borderRadius:8,backgroundColor:taskBg,flexDirection:'row',alignItems:'center',gap:10,marginBottom:5}}><Text style={{fontSize:17,color:taskColor,fontWeight:'900'}}>✓</Text><View style={{flex:1}}><Text style={{fontSize:11,fontWeight:'800',color:palette.ink}}>{selectedContainer?`${selectedContainer.container_number} · ${types.find(t=>t.id===taskType)?.label}`:'Select a container to continue'}</Text><Text style={{fontSize:10,color:palette.muted,marginTop:3}}>{selectedLocation?`Destination reserved: ${selectedLocation.location_code}`:needsYardSlot?'Choose a destination to create and reserve the task.':'Gate-lane handover will be confirmed during task execution.'}</Text></View></View>
    </ScrollView>
    <View style={{borderTopWidth:1,borderTopColor:palette.line,paddingTop:13,marginTop:5,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap'}}>
      <Text style={{fontSize:10,color:palette.muted,flex:1,minWidth:150}}>{ready?'Task details ready for dispatch.':'Select a container'+(needsYardSlot?' and eligible destination':'')+' to continue.'}</Text>
      <View style={{flexDirection:'row',gap:8}}><Pressable onPress={onCancel} style={{paddingHorizontal:15,paddingVertical:10,borderRadius:7,borderWidth:1,borderColor:palette.line,backgroundColor:palette.white}}><Text style={{fontSize:11,fontWeight:'700',color:palette.ink}}>Cancel</Text></Pressable><Pressable disabled={!ready||saving} onPress={onCreate} style={{paddingHorizontal:16,paddingVertical:10,borderRadius:7,backgroundColor:ready&&!saving?palette.teal:'#a7c8c2',minWidth:155,alignItems:'center'}}><Text style={{fontSize:11,fontWeight:'800',color:palette.white}}>{saving?'Creating…':'Create & reserve task'}</Text></Pressable></View>
    </View>
  </>;
}
