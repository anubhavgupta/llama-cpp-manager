// Phase 1 fake nvidia-smi (plan.md §2 Phase 1.3): stands in for the real binary on PATH so the
// win32 branch of server.js getSystemMetrics() can be driven deterministically, and can be taken
// off PATH to force the Math.random() simulated-metrics path (Q6).
//
// Output shape is fixed at utilization.gpu, memory.total, memory.used — the field order of the
// server.js query string --query-gpu=utilization.gpu,memory.total,memory.used.
// Mode comes from NVIDIA_SMI_STUB_MODE: ok (default) | multi | garbage | fail | hang.
'use strict';

const OK_LINE = '42, 24576, 12345';
const MULTI_LINES = [OK_LINE, '11, 1111, 111', '22, 2222, 222'];

const args = process.argv.slice(2);
const hasFormat = args.includes('--format=csv,noheader,nounits');
const hasQuery = args.some(a => a.startsWith('--query-gpu='));

if (!hasFormat || !hasQuery) {
    process.stderr.write(`nvidia-smi-stub: unexpected invocation: ${JSON.stringify(args)}\n`);
    process.exit(1);
}

const mode = process.env.NVIDIA_SMI_STUB_MODE || 'ok';

switch (mode) {
    case 'ok':
        process.stdout.write(OK_LINE + '\n');
        break;
    case 'multi':
        process.stdout.write(MULTI_LINES.join('\n') + '\n');
        break;
    case 'garbage':
        process.stdout.write('not a csv\n');
        break;
    case 'fail':
        process.exit(1);
        break;
    case 'hang':
        // Silent for 30 s; the harness kills it long before the self-terminating timeout.
        setTimeout(() => process.exit(0), 30000);
        break;
    default:
        process.stderr.write(`nvidia-smi-stub: unknown NVIDIA_SMI_STUB_MODE: ${mode}\n`);
        process.exit(1);
}
