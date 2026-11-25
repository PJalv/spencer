import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../../src/daemon.ts';
import { Api, tempDir, testRelay, waitFor } from './harness.ts';

test('two Spencers: group requests obey live peer MCP guardrails in Full Trust', {timeout:60000}, async () => {
  const t=tempDir('spencer-policies-'); const relay=await testRelay(t.dir,undefined);
  const fixture=fileURLToPath(new URL('../agent/fixtures/echo-mcp-server.ts',import.meta.url));
  const nodes: Daemon[]=[];
  try {
    for(const name of ['Alice','Bob']) {
      const daemon=new Daemon({dataDir:join(t.dir,name),config:{name,relay:relay.url,http:{host:'127.0.0.1',port:0},model:{provider:'fake'},mcpServers: name==='Alice'?{echo:{command:process.execPath,args:[fixture]}}:{}},log(){},webRoot:null});
      nodes.push(daemon); await daemon.start();
    }
    const [a,b]=nodes; const A=new Api(a.port,a.token), B=new Api(b.port,b.token);
    const invite=await A.createInvite('group','Guarded'); await B.acceptInvite(invite.link); const ch=invite.channel.id;
    await waitFor(()=>a.core.getChannel(ch)!.members.length===2,'peer joined');
    await A.req('PATCH',`/api/channels/${ch}`,{trust:'full'});
    await B.req('PATCH',`/api/channels/${ch}`,{autoReply:false});
    await waitFor(async()=> (await A.req<{mcp:{status:string}[]}>('GET','/api/state')).mcp.some(s=>s.status==='connected'),'MCP connected');
    await A.req('PUT',`/api/peers/${b.identity.id}/tool-policies`,{rules:[
      {toolPattern:'*pid',effect:'deny'},
      {toolPattern:'*fail',effect:'ask_owner'},
      {toolPattern:'*echo',effect:'allow'}
    ]});
    const call=async(tool:string,args:unknown)=>{
      const sent=await B.say(ch,`please call mcp__echo__${tool} ${JSON.stringify(args)}`,[a.identity.id]);
      return await waitFor(async()=> (await A.messages(ch)).find(m=>m.replyTo===sent.id&&m.mine)?.text,'policy response');
    };
    assert.match(await call('echo',{text:'hello'}),/echo: hello/);
    assert.match(await call('fail',{}),/Policy violation:.*ask_owner/);
    assert.doesNotMatch(await call('pid',{}),/done: \d+/);
  } finally {for(const n of nodes.reverse()) await n.stop(); await relay.stop(); t.cleanup();}
});
