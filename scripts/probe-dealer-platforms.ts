import { fetchWithTls } from '../src/transport/tls.js';

/**
 * Identifies which website platform a dealer group runs on.
 *
 * A dealer platform is worth far more than a dealer. Every storefront on one
 * answers the same endpoint with the same payload shape, so once a platform is
 * wired the next rooftop on it costs a host and an id. Dealer.com is already
 * read this way and covers Lithia's 40,995 used cars from three lines of
 * config, so the question worth asking about the rest of the retail market is
 * not "which dealers exist" but "which platforms do they sit on".
 */

/** Markers each platform leaves in the HTML it serves. */
const PLATFORMS: [string, RegExp][] = [
  ['dealer.com', /ws-inv-data|dealer\.com\/static|dealerdotcom/i],
  ['Dealer Inspire', /dealerinspire|di-js|apis\/widget\/INVENTORY_LISTING/i],
  ['DealerOn', /dealeron|DealerOnCommon|dlron/i],
  ['Sincro/CDK', /sincrodigital|cdkglobal|fortellis/i],
  ['eBizAutos', /ebizautos/i],
  ['DealerSocket', /dealersocket|dsdealerfire/i],
  ['Shift Digital', /shiftdigital/i],
  ['AutoFi', /autofi\.com/i],
  ['Tekion', /tekion/i],
];

const GROUPS: [string, string][] = [
  ['penske', 'https://www.penskecars.com'],
  ['autonation', 'https://www.autonation.com'],
  ['group1', 'https://www.group1auto.com'],
  ['asburyauto', 'https://www.asburyauto.com'],
  ['larrymiller', 'https://www.larryhmillerdealerships.com'],
  ['kengarff', 'https://www.kengarff.com'],
  ['morgan', 'https://www.morganautogroup.com'],
  ['westherr', 'https://www.westherr.com'],
  ['holman', 'https://www.holmanauto.com'],
  ['galpin', 'https://www.galpin.com'],
  ['jimkoons', 'https://www.koons.com'],
  ['rickhendrick', 'https://www.hendrickcars.com'],
  ['davidmcdavid', 'https://www.davidmcdavid.com'],
  ['carter', 'https://www.cartersubaru.com'],
  ['schomp', 'https://www.schomp.com'],
  ['napleton', 'https://www.napleton.com'],
  ['zeigler', 'https://www.zeiglerauto.com'],
  ['walser', 'https://www.walser.com'],
  ['bommarito', 'https://www.bommarito.com'],
  ['kellyauto', 'https://www.kellyauto.com'],
  ['leithcars', 'https://www.leithcars.com'],
  ['gurley', 'https://www.gurleyleepmotors.com'],
  ['germain', 'https://www.germaincars.com'],
  ['jerryseiner', 'https://www.jerryseiner.com'],
];

const keepAlive = setInterval(() => {}, 1000);
const queue = [...GROUPS];
const tally = new Map<string, string[]>();

await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      const [id, host] = entry;
      try {
        const r = await fetchWithTls(host);
        const body = r.body ?? '';
        if (r.status !== 200) { console.log(`${id.padEnd(16)} HTTP ${r.status}`); continue; }
        const hits = PLATFORMS.filter(([, re]) => re.test(body)).map(([name]) => name);
        const label = hits.length ? hits.join('+') : 'unrecognised';
        for (const h of hits) tally.set(h, [...(tally.get(h) ?? []), id]);
        console.log(`${id.padEnd(16)} ${String(Math.round(body.length / 1024)).padStart(5)}KB  ${label}`);
      } catch (e) {
        console.log(`${id.padEnd(16)} ERR ${(e as Error).message.split('\n')[0].slice(0, 40)}`);
      }
    }
  }),
);

clearInterval(keepAlive);
console.log('\nplatforms found:');
for (const [name, ids] of [...tally].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(ids.length).padStart(2)} x ${name.padEnd(16)} ${ids.join(', ')}`);
}
