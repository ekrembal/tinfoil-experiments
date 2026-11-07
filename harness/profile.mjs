export function buildProfile(profile) {
  if(profile==='offline')return {profile,worker_egress:{mode:'allowlist',allow:['inference.tinfoil.sh']}};
  if(profile==='online')return {profile,worker_egress:{mode:'open'}};
  throw new Error('APP_PROFILE must be offline or online');
}

export function releaseProfile(tag) {
  if(typeof tag!=='string'||!tag)throw new Error('verified release tag required for profile policy');
  return tag.endsWith('-online')?'online':'offline';
}
