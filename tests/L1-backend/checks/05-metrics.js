'use strict';

// /metrics group, one session per nvidia-smi stub mode. Q6 pins that GPU/VRAM come from
// Math.random() whenever nvidia-smi cannot answer, so the values cannot be byte-compared; the
// comparison policy for all three modes lives in fixtures/COMPARISON.json (metrics-body-stub,
// metrics-body-unparsable, metrics-body-simulated) and this group applies it, then adds the
// statistical claim on top of the recorded per-sample bounds.
//
// All three modes are recorded truths:
//   ok       -> the stub's canned numbers, byte-exact except cpu/ram
//   garbage  -> 'not a csv' parses without throwing, so gpu/vram stay at their initialised 0 and
//               vramUsage is "0/0" (fixtures/http/J2b-metrics-garbage/shape-note.json)
//   fail     -> execSync throws, the catch branch simulates: 0<gpu<50, 0<vram<60, total 8192

const { assert, compareFixture, delay, fixtureBytes, ruleFor, waitFor } = require('../lib/harness');

const SAMPLES = 200;
const TAIL = 20;
const TAIL_WAIT_MS = 2500;

async function sample(ctx, count) {
    const bodies = [];
    for (let index = 0; index < count; index += 1) {
        const res = await ctx.get('/metrics');
        assert(res.status === 200, 'L1.METRICS.SAMPLE-STATUS', 'GET /metrics returned ' + res.status);
        bodies.push(res.raw.toString('utf8'));
    }
    return bodies;
}

// Every sample has to satisfy the mode's own recorded rule; the set of distinct bodies is the
// statistical claim (canned/zeros never move, the simulated path always moves).
async function checkSamples(ctx, journey, mode, expect) {
    const rule = ruleFor('http/' + journey + '/metrics-1.response');
    const bodies = await sample(ctx, SAMPLES);
    await delay(TAIL_WAIT_MS);
    const tail = await sample(ctx, TAIL);
    const all = bodies.concat(tail);
    for (const rel of ['metrics-1', 'metrics-2', 'metrics-3']) {
        compareFixture('http/' + journey + '/' + rel + '.response', Buffer.from(all[Number(rel.slice(-1)) - 1], 'utf8'));
    }
    const parsed = all.map((text) => JSON.parse(text));
    const errors = [];
    parsed.forEach((body, index) => {
        if (Object.keys(body).join(',') !== 'cpu,ram,gpu,vram,vramUsage') {
            errors.push('sample ' + index + ' key set ' + Object.keys(body).join(','));
            return;
        }
        const usage = String(body.vramUsage).split('/');
        if (usage.length !== 2 || usage.some((part) => !/^[0-9.]+$/.test(part))) {
            errors.push('sample ' + index + ' vramUsage ' + body.vramUsage + ' is not `${total-free}/${total}`');
        }
        if (!(body.cpu > 0)) errors.push('sample ' + index + ' cpu ' + body.cpu + ' is not a live reading');
        if (!(body.ram > 0)) errors.push('sample ' + index + ' ram ' + body.ram + ' is not a live reading');
        for (const [name, value] of [['gpu', body.gpu], ['vram', body.vram]]) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                errors.push('sample ' + index + ' ' + name + ' is ' + JSON.stringify(value));
            } else if (value < expect[name][0] || value > expect[name][1]) {
                errors.push('sample ' + index + ' ' + name + '=' + value + ' outside the recorded band [' +
                    expect[name][0] + ', ' + expect[name][1] + '] for stub mode ' + mode);
            }
        }
        if (expect.total !== null && String(body.vramUsage).split('/')[1] !== expect.total) {
            errors.push('sample ' + index + ' vramUsage ' + body.vramUsage + ' does not carry the' +
                ' recorded total ' + expect.total);
        }
        if (expect.stub !== null && body.vramUsage === expect.stub) {
            errors.push('sample ' + index + ' equals the stub-derived vramUsage on the ' + mode + ' path');
        }
    });
    assert(errors.length === 0, 'L1.METRICS.SHAPE-' + mode,
        errors.length + ' of ' + all.length + ' ' + mode + ' samples violate the recorded shape' +
        ' (first 6):\n      ' + errors.slice(0, 6).join('\n      ') +
        '\n      fixture: fixtures/http/' + journey + '/  rule ' + (rule ? rule.id : 'exact'));
    const distinct = new Set(all).size;
    // Recorded constant-ness is about the GPU triple only: cpu and ram are real OS readings and move
    // on every path (fixtures/http/J2b-metrics-garbage/shape-note.json: gpu=0, vram=0,
    // vramUsage="0/0" alongside real cpu/ram).
    const gpuFields = new Set(parsed.map((body) =>
        JSON.stringify([body.gpu, body.vram, body.vramUsage])));
    const goldenGpu = (() => {
        const golden = JSON.parse(fixtureBytes('http/' + journey + '/metrics-1.response').toString('utf8'));
        return [golden.gpu, golden.vram, golden.vramUsage];
    })();
    if (expect.moves) {
        assert(gpuFields.size >= 2, 'L1.METRICS.VARIES-' + mode,
            'all ' + all.length + ' ' + mode + ' samples reported the same gpu/vram/vramUsage (' +
            [...gpuFields][0] + '), so the simulated path looks constant rather than Math.random()');
    } else {
        assert(gpuFields.size === 1, 'L1.METRICS.CONSTANT-' + mode,
            'the ' + mode + ' path produced ' + gpuFields.size + ' distinct gpu/vram/vramUsage triples;'
            + ' this mode is recorded as one constant value: ' +
            JSON.stringify([...gpuFields].slice(0, 3)) +
            '\n      fixture: fixtures/http/' + journey + '/');
        assert([...gpuFields][0] === JSON.stringify(goldenGpu),
            'L1.METRICS.CONSTANT-VALUE-' + mode,
            'the ' + mode + ' path reports ' + [...gpuFields][0] + ', the recorded constant is ' +
            JSON.stringify(goldenGpu) + '\n      fixture: fixtures/http/' + journey + '/');
    }
    return all.length + ' samples (' + SAMPLES + ' + ' + TAIL + ' after ' + TAIL_WAIT_MS + ' ms),' +
        ' ' + distinct + ' distinct, rule ' + (rule ? rule.id : 'exact') +
        ', fixture family fixtures/http/' + journey + '/';
}

module.exports = [
    {
        name: 'metrics-simulated',
        stubMode: 'fail',
        async run(ctx) {
            await ctx.check('L1.METRICS.SIMULATED-SHAPE', 'Q6', () => checkSamples(ctx, 'J2c-metrics-fail', 'fail', {
                gpu: [0, 50], vram: [0, 60], total: '8192', stub: '12345/24576', moves: true
            }));

            await ctx.check('L1.METRICS.SIMULATED-NOT-REAL', 'Q6', async () => {
                const golden = JSON.parse(fixtureBytes('http/J2c-metrics-fail/metrics-1.response').toString('utf8'));
                const live = JSON.parse((await ctx.get('/metrics')).raw.toString('utf8'));
                assert(live.vramUsage !== golden.vramUsage || live.gpu !== golden.gpu,
                    'L1.METRICS.SIMULATED-NOT-REAL',
                    'the simulated path repeated the recorded sample verbatim (' +
                    JSON.stringify(golden) + '), which is the shape of a constant, not of Math.random()');
                assert(String(live.vramUsage).endsWith('/8192'), 'L1.METRICS.SIMULATED-TOTAL',
                    'Q6: the simulated path must report the hardcoded 8 GB total, got ' + live.vramUsage);
                return 'vramUsage ' + live.vramUsage + ' — simulated total 8192, values not the recorded sample';
            });
        }
    },
    {
        name: 'metrics-unparsable',
        stubMode: 'garbage',
        async run(ctx) {
            await ctx.check('L1.METRICS.GARBAGE-ZEROS', 'Q6', () => checkSamples(ctx, 'J2b-metrics-garbage', 'garbage', {
                gpu: [0, 0], vram: [0, 0], total: '0', stub: '12345/24576', moves: false
            }));

            await ctx.check('L1.METRICS.GARBAGE-RECORDED-NOTE', 'Q6', async () => {
                const note = JSON.parse(require('../lib/harness').fixtureBytes('http/J2b-metrics-garbage/shape-note.json').toString('utf8'));
                assert(note.stubReply === 'not a csv', 'L1.METRICS.GARBAGE-NOTE',
                    'the recorded garbage-stub note does not describe the reply this stub sends: ' +
                    JSON.stringify(note.stubReply));
                const body = JSON.parse((await ctx.get('/metrics')).raw.toString('utf8'));
                assert(body.gpu === 0 && body.vram === 0 && body.vramUsage === '0/0',
                    'L1.METRICS.GARBAGE-ZERO-VALUES',
                    'NVIDIA_SMI_STUB_MODE=garbage no longer reports zeros: ' + JSON.stringify(body) +
                    '\n      fixture: fixtures/http/J2b-metrics-garbage/metrics-1.response');
                return 'zeros + "0/0" confirmed against ' + 'fixtures/http/J2b-metrics-garbage/shape-note.json';
            });
        }
    },
    {
        name: 'metrics-stub',
        stubMode: 'ok',
        async run(ctx) {
            await ctx.check('L1.METRICS.STUB-CANNED', 'Q6', () => checkSamples(ctx, 'J1-settings', 'ok', {
                gpu: [42, 42], vram: [50.23193359375, 50.23193359375], total: '24576', stub: null, moves: false
            }));

            await ctx.check('L1.METRICS.STUB-FORMAT', 'contract', async () => {
                const body = JSON.parse((await ctx.get('/metrics')).raw.toString('utf8'));
                assert(body.vramUsage === '12345/24576', 'L1.METRICS.STUB-FORMAT',
                    'vramUsage must be `${total-free}/${total}` of the stub reply 42, 24576, 12345;' +
                    ' got ' + body.vramUsage);
                return '${total-free}/${total} == 12345/24576 (24576 total, 12345 used)';
            });
        }
    }
];
