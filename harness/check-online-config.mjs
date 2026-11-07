import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const root=await readFile('tinfoil-config.yml'),online=await readFile('tinfoil-config.online.yml');
assert.ok(root.equals(online),'online root must be byte-identical to tinfoil-config.online.yml');
const config=YAML.parse(root.toString()),signer=config.containers.find(c=>c.name==='signer'),worker=config.containers.find(c=>c.name==='worker');
assert.deepEqual(signer.networks,['internal']);assert.equal(config.networks.internal.egress,'closed');
assert.deepEqual(worker.networks,['internet','internal']);assert.equal(config.networks.internet.egress,'open');assert.equal(config.networks.internet.allow,undefined);
assert.deepEqual(signer.keys,['job-signing']);assert.equal(signer.attestation,true);assert.deepEqual(signer.secrets,['JOBS_BEARER_TOKEN']);
assert.ok(!worker.keys?.length);assert.ok(!worker.attestation);assert.deepEqual(worker.secrets,['TINFOIL_API_KEY']);
assert.equal(signer.image,worker.image);
for(const c of [signer,worker])assert.equal(c.env.find(e=>e.APP_PROFILE)?.APP_PROFILE,'online');
console.log('PASS: online configs are byte-identical; worker internet is unrestricted; signer network, key, attestation and secrets remain isolated');
