import { describe, expect, it } from 'vitest'
import { buildExecutionPlan, computeProfileConfigHash, getRunnerProfile, type JobRecord } from '@dsh-scholar/research-schemas'
import { probeDockerExecutionEnvironment } from '@dsh-scholar/runner-gateway'

const profile = getRunnerProfile('profile_local_docker_cpu_v1')!
const job = {
  job_id: 'job_probe', project_id: 'prj_probe', contract_id: null, idempotency_key: 'probe',
  kind: 'smoke', command: ['true'], payload: {
    project_config_pin: `sha256:${'1'.repeat(64)}`,
    runner_target_id: 'local-docker',
    runner_target_kind: 'local-docker',
    runner_target_revision: 1,
    runner_target_hash: `sha256:${'a'.repeat(64)}`,
    runner_profile_id: profile.profile_id,
    profile_config_hash: computeProfileConfigHash(profile),
    image_digest: 'registry/research@sha256:' + 'e'.repeat(64),
    runner_compute: { mode: 'cpu' },
  }, status: 'running', failure_class: null,
  lease_owner: 'runner', lease_expires_at: null, heartbeat_at: null, lease_generation: 1,
  lease_token: 'token', attempts: 1, max_attempts: 1, run_manifest: null, error: '',
  created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:00:00.000Z',
} satisfies JobRecord

function plan(compute: { mode: 'cpu' } | { mode: 'nvidia'; devices: 'all' | string[] }) {
  return buildExecutionPlan({ ...job, payload: { ...job.payload, runner_compute: compute } } as JobRecord, {
    run_id: 'run_probe', lease: { owner: 'runner', generation: 1, token: 'token', expires_at: null },
    timeout_ms: 1000,
  })
}

describe('Docker execution preflight', () => {
  it('checks daemon and image for CPU without probing NVIDIA', async () => {
    const calls: string[] = []
    const report = await probeDockerExecutionEnvironment(plan({ mode: 'cpu' }), async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      return { stdout: '', stderr: '' }
    })
    expect(report).toMatchObject({ ok: true, code: 'ready' })
    expect(calls).toEqual([
      'docker info',
      `docker image inspect registry/research@sha256:${'e'.repeat(64)}`,
    ])
  })

  it('checks NVIDIA toolkit and requested devices before docker run', async () => {
    const calls: string[] = []
    const report = await probeDockerExecutionEnvironment(plan({ mode: 'nvidia', devices: ['0', '2'] }), async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      if (file === 'docker' && args[0] === 'info' && args.length > 1) return { stdout: '{"nvidia":{}}', stderr: '' }
      if (file === 'nvidia-smi') return { stdout: '0\n1\n2\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    expect(report).toMatchObject({ ok: true, code: 'ready', available_devices: ['0', '1', '2'] })
    expect(calls.some(call => call.startsWith('nvidia-smi '))).toBe(true)
  })

  it('returns a stable safe code when an NVIDIA device is unavailable', async () => {
    const report = await probeDockerExecutionEnvironment(plan({ mode: 'nvidia', devices: ['3'] }), async (file, args) => {
      if (file === 'docker' && args[0] === 'info' && args.length > 1) return { stdout: '{"nvidia":{}}', stderr: '' }
      if (file === 'nvidia-smi') return { stdout: '0\n1\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    expect(report).toEqual({ ok: false, code: 'gpu_device_unavailable', available_devices: ['0', '1'] })
  })

  it('uses stable codes for unavailable daemon and immutable image', async () => {
    const daemon = await probeDockerExecutionEnvironment(plan({ mode: 'cpu' }), async () => {
      throw new Error('sensitive host detail')
    })
    expect(daemon).toEqual({ ok: false, code: 'docker_unavailable' })

    const image = await probeDockerExecutionEnvironment(plan({ mode: 'cpu' }), async (_file, args) => {
      if (args[0] === 'image') throw new Error('private registry response')
      return { stdout: '', stderr: '' }
    })
    expect(image).toEqual({ ok: false, code: 'image_unavailable' })
  })

  it('does not collapse NVIDIA runtime or nvidia-smi failures into CPU', async () => {
    const runtime = await probeDockerExecutionEnvironment(plan({ mode: 'nvidia', devices: 'all' }), async (file, args) => {
      if (file === 'docker' && args.length > 1) return { stdout: '{}', stderr: '' }
      return { stdout: '', stderr: '' }
    })
    expect(runtime).toEqual({ ok: false, code: 'nvidia_runtime_unavailable' })

    const driver = await probeDockerExecutionEnvironment(plan({ mode: 'nvidia', devices: 'all' }), async (file, args) => {
      if (file === 'docker' && args.length > 1) return { stdout: '{"nvidia":{}}', stderr: '' }
      if (file === 'nvidia-smi') throw new Error('driver detail')
      return { stdout: '', stderr: '' }
    })
    expect(driver).toEqual({ ok: false, code: 'nvidia_smi_unavailable' })
  })
})
