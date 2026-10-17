import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyDetachedSignature,CLAUDE_RELEASE_PUBLIC_KEY,CLAUDE_RELEASE_KEY_FINGERPRINT} from '../src/openpgp-verify.js';
// Real, unmodified 2.1.292 release files (signature checked independently with gpg when the fixture was added).
const fixture=(name:string)=>readFile(new URL(`../../test/fixtures/${name}`,import.meta.url));
test('official release manifest verifies against the pinned Anthropic key',async()=>{
 const manifest=await fixture('claude-2.1.292-manifest.json'),signature=(await fixture('claude-2.1.292-manifest.json.sig')).toString('utf8');
 assert.doesNotThrow(()=>verifyDetachedSignature(manifest,signature));
 assert.doesNotThrow(()=>verifyDetachedSignature(manifest.toString('utf8'),signature));
});
test('modified manifest, wrong signature, truncation and garbage are rejected',async()=>{
 const manifest=await fixture('claude-2.1.292-manifest.json'),signature=(await fixture('claude-2.1.292-manifest.json.sig')).toString('utf8');
 const tampered=Buffer.from(manifest),at=tampered.indexOf("\"checksum\"")+14;tampered[at]=tampered[at]!^1;
 assert.throws(()=>verifyDetachedSignature(tampered,signature),/signature/i);
 assert.throws(()=>verifyDetachedSignature(Buffer.concat([manifest,Buffer.from(' ')]),signature),/signature/i);
 const lines=signature.split('\n');const body=lines.findIndex(l=>l.trim()==='')+1;lines[body]=lines[body]!.replace(/^./,c=>c==='i'?'j':'i');
 assert.throws(()=>verifyDetachedSignature(manifest,lines.join('\n')));
 assert.throws(()=>verifyDetachedSignature(manifest,signature.split('\n').slice(0,6).join('\n')));
 assert.throws(()=>verifyDetachedSignature(manifest,'not a signature'));
 assert.throws(()=>verifyDetachedSignature(manifest,''));
});
test('only the pinned key fingerprint is accepted, even if the key material is supplied',async()=>{
 const manifest=await fixture('claude-2.1.292-manifest.json'),signature=(await fixture('claude-2.1.292-manifest.json.sig')).toString('utf8');
 assert.throws(()=>verifyDetachedSignature(manifest,signature,CLAUDE_RELEASE_PUBLIC_KEY,'0'.repeat(40)),/pinned|fingerprint/i);
 assert.equal(CLAUDE_RELEASE_KEY_FINGERPRINT,'31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE');
});
