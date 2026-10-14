import assert from 'node:assert/strict';
import test from 'node:test';
import { isRuntimeBootstrapURL } from '../src/bootstrap.js';

test('recognizes only owned Linux and Windows bootstrap files', () => {
  for (const value of [
    'file:///opt/hoosaidthat/bootstrap.html',
    'file:///opt/hoosaidthat/bootstrap.html#ready',
    'file:///C:/HooSaidThat/bootstrap.html',
    'file:///c:/hoosaidthat/BOOTSTRAP.HTML',
    'file:///C:/HooSaidThat/bootstrap.html?session=ready',
  ]) assert.equal(isRuntimeBootstrapURL(value), true, value);
  for (const value of [
    'about:blank', 'not-a-url',
    'https://example.test/opt/hoosaidthat/bootstrap.html',
    'file:///opt/hoosaidthat/bootstrap.html.bak',
    'file:///opt/hoosaidthat/Bootstrap.html',
    'file:///C:/other/bootstrap.html',
    'file://unowned-host/C:/HooSaidThat/bootstrap.html',
    'file:///C:/HooSaidThat/bootstrap.html.backup',
  ]) assert.equal(isRuntimeBootstrapURL(value), false, value);
});
