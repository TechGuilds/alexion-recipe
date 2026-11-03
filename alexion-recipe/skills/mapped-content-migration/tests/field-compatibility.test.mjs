import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceFormatMatches} from '../scripts/lib/field-compatibility.mjs';
import {id} from './fixture-factory.mjs';

test('supported reference formats require valid XML characters and matching ordered IDs',()=>{
  const media={kind:'media',targetSourceIds:[id(1)]};
  for(const alt of ['a < b','a & b','&#0;','&unknown;'])assert.equal(referenceFormatMatches(media,`<image mediaid="${id(1)}" alt="${alt}" />`,'Image'),false,alt);
  assert.equal(referenceFormatMatches(media,`<image mediaid="${id(1)}" alt="a &amp; b &#x20;" />`,'Image'),true);
  assert.equal(referenceFormatMatches({kind:'list',targetSourceIds:[id(1),id(2)]},`${id(2)}|${id(1)}`,'Multilist'),false);
});

test('raw-compatible single/list syntax respects cardinality in both directions',()=>{
  assert.equal(referenceFormatMatches({kind:'datasource',targetSourceIds:[id(1)]},id(1),'Multilist'),true);
  assert.equal(referenceFormatMatches({kind:'list',targetSourceIds:[id(1)]},id(1),'Droplink'),true);
  assert.equal(referenceFormatMatches({kind:'list',targetSourceIds:[id(1),id(2)]},`${id(1)}|${id(2)}`,'Droplink'),false);
});
