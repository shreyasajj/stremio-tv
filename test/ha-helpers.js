// Home Assistant test helpers for the native end-to-end test: a real
// Mosquitto broker (with a password, like the HA add-on), mosquitto_sub /
// mosquitto_pub wrappers, and a tiny mDNS responder that answers for
// `_home-assistant._tcp.local` the way HA does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawn, spawnSync, execFile } = require('child_process');

const BROKER = { host: '127.0.0.1', port: 1883, username: 'stremio-tv', password: 'secret' };
const AUTH = ['-h', BROKER.host, '-p', String(BROKER.port), '-u', BROKER.username, '-P', BROKER.password];

function haveMosquitto() {
  return ['mosquitto', 'mosquitto_sub', 'mosquitto_pub', 'mosquitto_passwd']
    .every((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0);
}

// Starts mosquitto on 127.0.0.1:1883 with one user; resolves once it listens.
async function startBroker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-mqtt-'));
  const pw = path.join(dir, 'passwd');
  spawnSync('mosquitto_passwd', ['-b', '-c', pw, BROKER.username, BROKER.password]);
  const conf = path.join(dir, 'mosquitto.conf');
  fs.writeFileSync(conf, [
    `listener ${BROKER.port} ${BROKER.host}`,
    'allow_anonymous false',
    `password_file ${pw}`,
    'persistence false',
    'user root', // the container runs as root; keep it able to read the password file
    '',
  ].join('\n'));
  const proc = spawn('mosquitto', ['-c', conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  for (let i = 0; i < 50; i++) {
    if (await retained('$SYS/broker/version', 500).catch(() => null)) return { proc, log };
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('mosquitto did not start:\n' + log.join(''));
}

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 8000 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });
}

// The retained message on `topic` (null if none within `ms`).
async function retained(topic, ms = 1500) {
  const out = await run('mosquitto_sub', [...AUTH, '-t', topic, '-C', '1', '-W', String(Math.ceil(ms / 1000)),
    ...(topic.startsWith('$SYS') ? [] : ['--retained-only'])]);
  return out === null ? null : out.replace(/\n$/, '');
}

function publish(topic, message) {
  return run('mosquitto_pub', [...AUTH, '-t', topic, '-m', message]);
}

// Records every message on `topics` as { at, retained, topic, payload }.
function watch(topics) {
  const messages = [];
  const proc = spawn('mosquitto_sub', [...AUTH, '-F', '%r|%t|%p', ...topics.flatMap((t) => ['-t', t])],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let rest = '';
  proc.stdout.on('data', (d) => {
    const lines = (rest + d).split('\n');
    rest = lines.pop();
    for (const line of lines) {
      const [flag, topic, ...payload] = line.split('|');
      messages.push({ at: Date.now(), retained: flag === '1', topic, payload: payload.join('|') });
    }
  });
  return { messages, stop: () => proc.kill() };
}

// Answers mDNS queries for HA's service with an A record for `address`, like
// Home Assistant's zeroconf does (to the asker's port: "legacy unicast").
function mdnsResponder(address) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const name = (n) => Buffer.concat([
    ...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0]),
  ]);
  const record = (n, type, data) => {
    const h = Buffer.alloc(10);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(1, 2);
    h.writeUInt32BE(120, 4);
    h.writeUInt16BE(data.length, 8);
    return Buffer.concat([name(n), h, data]);
  };
  const queries = [];
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12 || (msg[2] & 0x80) || !msg.includes(Buffer.from('_home-assistant'))) return;
    queries.push(rinfo);
    const header = Buffer.from([msg[0], msg[1], 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    sock.send(Buffer.concat([
      header,
      record('_home-assistant._tcp.local', 12, name('Home._home-assistant._tcp.local')),
      record('homeassistant.local', 1, Buffer.from(address.split('.').map(Number))),
    ]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(5353, () => {
    try { sock.addMembership('224.0.0.251'); } catch (e) { console.log('  (mDNS membership failed:', e.message + ')'); }
    resolve({ queries, close: () => sock.close() });
  }));
}

module.exports = { BROKER, haveMosquitto, startBroker, retained, publish, watch, mdnsResponder };
