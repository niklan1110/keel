import assert from 'node:assert/strict';
import type os from 'node:os';
import test from 'node:test';
import { functionNetworks, isFunctionPeer } from './peers.js';

const iface = (address: string, cidr: string) => ({ address, cidr, netmask: '', family: 'IPv4' as const, mac: '', internal: false });
const studioInterfaces = {
  lo: [{ ...iface('127.0.0.1', '127.0.0.1/8'), internal: true }],
  eth0: [iface('172.18.0.4', '172.18.0.4/16')], // default network
  eth1: [iface('172.20.0.3', '172.20.0.3/16')], // functions network
  eth2: [iface('172.22.0.2', '172.22.0.2/16')], // public network
} as ReturnType<typeof os.networkInterfaces>;

test('the functions network is the Studio network that holds the functions container', () => {
  const nets = functionNetworks(studioInterfaces, ['172.20.0.5']);
  assert.equal(nets.length, 1);
  assert.equal(functionNetworks(studioInterfaces, ['::ffff:172.20.0.5']).length, 1);
  assert.equal(functionNetworks(studioInterfaces, []).length, 0);
});

test('every address on the functions network is refused, not just the one DNS gave', () => {
  const fnIps = new Set(['172.20.0.5']);
  const nets = functionNetworks(studioInterfaces, [...fnIps]);
  assert.equal(isFunctionPeer('172.20.0.5', fnIps, nets), true);
  assert.equal(isFunctionPeer('::ffff:172.20.0.9', fnIps, nets), true); // restarted with a new address
});

test('the host, Studio itself and other networks are not function peers', () => {
  const fnIps = new Set(['172.20.0.5']);
  const nets = functionNetworks(studioInterfaces, [...fnIps]);
  assert.equal(isFunctionPeer('172.20.0.1', fnIps, nets), false); // the Docker host on that network
  assert.equal(isFunctionPeer('172.20.0.3', fnIps, nets), false);
  assert.equal(isFunctionPeer('172.18.0.1', fnIps, nets), false);
  assert.equal(isFunctionPeer('192.168.1.20', fnIps, nets), false);
  assert.equal(isFunctionPeer(undefined, fnIps, nets), false);
});
