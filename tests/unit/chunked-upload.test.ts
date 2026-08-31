/**
 * CHUNK-01 — 批量分块上传（init-grill-upload-models.md §3，规范性契约；
 * api-contracts.md §16 artifact-stages；hardening-v0.2-status.md §3
 * CHUNK-01 行）。覆盖：
 *
 * 服务端会话全生命周期（ResearchKernel + HTTP 面）：
 *   begin（配额事务性预留、文件名安全、chunk 协商、expiry ≥24h）→
 *   append（Content-Range 顺序追加 / 乱序 gap 409 / overlap 不同内容 409 /
 *   同字节 hash 重放 replayed=true / total 不同 409 / hash 不匹配 422 /
 *   chunk 超上限 413 / 越界 422）→ finalize（offset 未满 422 chunk_incomplete、
 *   流式重算 size/sha256、整体 hash 不一致 422 不产 artifact、成功注册
 *   IntakeArtifact（staged）、重复 finalize 幂等返回同一 artifact）→
 *   abort（幂等、staging 字节清理）→ GC（cleanupUploadSessions 过期回收）、
 *   配额上限 413 upload_quota_exceeded、>32MiB 大文件 scan（流式 hash）。
 *
 * 客户端队列状态机（dsh-research-ui/src/client/chunked-upload.ts，PURE）：
 *   hashing→queued→uploading→finalizing→scanning；pause/resume/retry；
 *   driveUpload 全生命周期（注入 fake transport）；消息 attachment ref。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import type {
  UploadBeginRequest, UploadBeginResult, UploadQueueItem, UploadTransport,
} from '../../packages/dsh-research-ui/src/client/chunked-upload'
import {
  chatAttachmentRef, driveUpload, enqueueFiles, markHashed, markUploading,
  browserTransport, nextChunkRange, pauseItem, queueSummary, resumeItem, retryItem, uploadFailure,
} from '../../packages/dsh-research-ui/src/client/chunked-upload'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chunk-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function beginResult(
  input: UploadBeginRequest,
  uploadId: string,
  committedOffset = 0,
  chunkSize = input.chunk_size ?? 8 * 1024 * 1024,
): UploadBeginResult {
  return {
    upload_id: uploadId,
    intake_id: input.intake_id,
    project_id: input.project_id,
    file_name: input.file_name,
    media_type: input.media_type,
    expected_size: input.expected_size,
    expected_sha256: input.expected_sha256 ?? null,
    chunk_size: chunkSize,
    committed_offset: committedOffset,
  }
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

/** Name-only project + its active Init Intake. */
function projectAndIntake(kernel: ResearchKernel): { projectId: string; intakeId: string } {
  const out = kernel.createProjectForGrill({
    name: 'chunk upload research',
    creator_principal_id: 'pi-1',
    idempotency_key: `ik-${Math.random().toString(36).slice(2)}`,
    request_hash: 'hash-1',
  })
  return { projectId: out.project.project_id, intakeId: out.intake.intake_id }
}

/** Upload `bytes` through the chunked pipeline; returns the artifact. */
function chunkedUpload(kernel: ResearchKernel, intakeId: string, fileBytes: Buffer, file_name = 'paper.pdf', expected_sha256?: string) {
  const session = kernel.beginUploadSession(intakeId, {
    file_name,
    media_type: 'application/pdf',
    expected_size: fileBytes.byteLength,
    expected_sha256,
    chunk_size: 8 * 1024 * 1024,
  })
  let offset = 0
  while (offset < fileBytes.byteLength) {
    const end = Math.min(offset + 8 * 1024 * 1024, fileBytes.byteLength)
    const chunk = fileBytes.subarray(offset, end)
    const result = kernel.appendUploadChunk(intakeId, session.upload_id, {
      bytes: chunk,
      contentRange: `bytes ${offset}-${end - 1}/${fileBytes.byteLength}`,
      chunkSha256: sha256(chunk),
    })
    expect(result.replayed).toBe(false)
    offset = result.committed_offset
  }
  return { session, artifact: kernel.finalizeUploadSession(intakeId, session.upload_id) }
}

describe('CHUNK-01 begin: session creation + quota reservation', () => {
  it('creates an open session bound to intake/project with committed offset 0 and ≥24h expiry', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'a.pdf', expected_size: 1000, expected_sha256: 'a'.repeat(64) })
    expect(session.status).toBe('open')
    expect(session.committed_offset).toBe(0)
    expect(session.expected_size).toBe(1000)
    expect(session.chunk_size).toBe(ResearchKernel.CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES)
    expect(new Date(session.expires_at).getTime() - Date.now()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000)
    const list = kernel.listUploadSessions(intakeId)
    expect(list).toHaveLength(1)
    expect(list[0]!.committed_offset).toBe(0)
  })

  it('rejects unsafe file names and unknown intakes (fail closed)', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    expectKernelError(() => kernel.beginUploadSession(intakeId, { file_name: '../evil.pdf', expected_size: 10 }), 422, 'invalid_file_name')
    expectKernelError(() => kernel.beginUploadSession('intk_nope', { file_name: 'a.pdf', expected_size: 10 }), 404, 'intake_not_found')
  })

  it('reserves quota transactionally: open sessions + staged artifacts count; over-quota is 413', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    // 2 GiB default quota: an expected_size over it is refused immediately.
    expectKernelError(() => kernel.beginUploadSession(intakeId, { file_name: 'big.bin', expected_size: ResearchKernel.INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES + 1 }), 413, 'upload_quota_exceeded')
    // Two sessions whose SUM exceeds the quota are refused on the second begin.
    const half = Math.floor(ResearchKernel.INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES * 0.6)
    kernel.beginUploadSession(intakeId, { file_name: 'a.bin', expected_size: half })
    expectKernelError(() => kernel.beginUploadSession(intakeId, { file_name: 'b.bin', expected_size: half }), 413, 'upload_quota_exceeded')
  })

  it('negotiates chunk size down to the instance cap (instance may tighten, never loosen)', () => {
    // Default instance cap is 8 MiB — a larger request is clamped down.
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const clamped = kernel.beginUploadSession(intakeId, { file_name: 'a.bin', expected_size: 10, chunk_size: 64 * 1024 * 1024 })
    expect(clamped.chunk_size).toBe(ResearchKernel.CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES)
    // An instance that raises the cap to 32 MiB (the hard max) allows it.
    const dir2 = mkdtempSync(join(tmpdir(), 'dsh-chunk-test2-'))
    const kernel2 = new ResearchKernel({ dbPath: join(dir2, 'kernel.db'), casRoot: join(dir2, 'cas'), requireSignedManifest: false, intakeChunkSizeBytes: 32 * 1024 * 1024 })
    const { intakeId: intake2 } = projectAndIntake(kernel2)
    const wide = kernel2.beginUploadSession(intake2, { file_name: 'b.bin', expected_size: 10, chunk_size: 64 * 1024 * 1024 })
    expect(wide.chunk_size).toBe(ResearchKernel.CHUNKED_UPLOAD_MAX_CHUNK_BYTES)
  })
})

describe('CHUNK-01 append: Content-Range + sha256 protocol', () => {
  const CHUNK_A = Buffer.from('aaaa') // 4 bytes
  const CHUNK_B = Buffer.from('bbbb')
  const CHUNK_C = Buffer.from('cc')

  function sessionWithTwoChunks(kernel: ResearchKernel, intakeId: string, expectedSize = 10) {
    const session = kernel.beginUploadSession(intakeId, { file_name: 'f.bin', expected_size: expectedSize, chunk_size: 4 })
    const r1 = kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-3/10', chunkSha256: sha256(CHUNK_A) })
    expect(r1.committed_offset).toBe(4)
    return { session, r1 }
  }

  it('appends in order and advances committed_offset', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const { session } = sessionWithTwoChunks(kernel, intakeId)
    const r2 = kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_B, contentRange: 'bytes 4-7/10', chunkSha256: sha256(CHUNK_B) })
    expect(r2.committed_offset).toBe(8)
    const view = kernel.listUploadSessions(intakeId)[0]!
    expect(view.committed_offset).toBe(8)
  })

  it('gap (start > committed) is 409 chunk_gap; out-of-order append fails closed', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const { session } = sessionWithTwoChunks(kernel, intakeId)
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_C, contentRange: 'bytes 8-9/10', chunkSha256: sha256(CHUNK_C) }),
      409, 'chunk_gap',
    )
    // 乱序：先发 offset 4 而 committed 仍是 0（新会话）。
    const s2 = kernel.beginUploadSession(intakeId, { file_name: 'g.bin', expected_size: 10, chunk_size: 4 })
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, s2.upload_id, { bytes: CHUNK_B, contentRange: 'bytes 4-7/10', chunkSha256: sha256(CHUNK_B) }),
      409, 'chunk_gap',
    )
  })

  it('same-byte/hash replay at an old offset succeeds with replayed=true; different content is 409', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const { session } = sessionWithTwoChunks(kernel, intakeId)
    const replay = kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-3/10', chunkSha256: sha256(CHUNK_A) })
    expect(replay.replayed).toBe(true)
    expect(replay.committed_offset).toBe(4)
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('XXXX'), contentRange: 'bytes 0-3/10', chunkSha256: sha256('XXXX') }),
      409, 'chunk_overlap_conflict',
    )
  })

  it('Content-Range total mismatch → 409 chunk_total_mismatch; body/range mismatch → 422', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 't.bin', expected_size: 10, chunk_size: 8 })
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-3/999', chunkSha256: sha256(CHUNK_A) }),
      409, 'chunk_total_mismatch',
    )
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-2/10', chunkSha256: sha256(CHUNK_A) }),
      422, 'chunk_range_mismatch',
    )
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'garbage', chunkSha256: sha256(CHUNK_A) }),
      422, 'invalid_content_range',
    )
  })

  it('sha256 mismatch → 422 chunk_hash_mismatch; missing header value → 422', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'h.bin', expected_size: 10, chunk_size: 8 })
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-3/10', chunkSha256: 'f'.repeat(64) }),
      422, 'chunk_hash_mismatch',
    )
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: CHUNK_A, contentRange: 'bytes 0-3/10', chunkSha256: 'not-a-hash' }),
      422, 'invalid_chunk_hash_header',
    )
  })

  it('chunk over the session cap → 413 chunk_too_large; beyond expected size → 422', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'l.bin', expected_size: 10, chunk_size: 4 })
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('0123456789'), contentRange: 'bytes 0-9/10', chunkSha256: sha256('0123456789') }),
      413, 'chunk_too_large',
    )
    const s2 = kernel.beginUploadSession(intakeId, { file_name: 'b.bin', expected_size: 4, chunk_size: 8 })
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, s2.upload_id, { bytes: Buffer.from('01234567'), contentRange: 'bytes 0-7/4', chunkSha256: sha256('01234567') }),
      422, 'chunk_beyond_size',
    )
  })

  it('appending to a finalized/aborted session is 409 upload_session_closed', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const { session, artifact } = chunkedUpload(kernel, intakeId, Buffer.from('0123456789'), 'ok.bin')
    expect(artifact.sha256).toBe(sha256('0123456789'))
    expectKernelError(
      () => kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('x'), contentRange: 'bytes 9-9/10', chunkSha256: sha256('x') }),
      409, 'upload_session_closed',
    )
  })
})

describe('CHUNK-01 finalize: streaming size/sha256 recompute → IntakeArtifact', () => {
  it('refuses finalize while offset < expected size (422 chunk_incomplete)', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'i.bin', expected_size: 10, chunk_size: 8 })
    kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('0123'), contentRange: 'bytes 0-3/10', chunkSha256: sha256('0123') })
    expectKernelError(() => kernel.finalizeUploadSession(intakeId, session.upload_id), 422, 'chunk_incomplete')
  })

  it('concatenates chunks and registers the IntakeArtifact with the server-computed whole-file sha256 (quarantine=staged)', () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const content = Buffer.concat([Buffer.from('aaaa'), Buffer.from('bbbb'), Buffer.from('cc')])
    const { artifact } = chunkedUpload(kernel, intakeId, content, 'paper.pdf', sha256(content))
    expect(artifact.sha256).toBe(sha256(content))
    expect(artifact.size_bytes).toBe(10)
    expect(artifact.quarantine).toBe('staged')
    expect(artifact.file_name).toBe('paper.pdf')
    // staged bytes live in the isolated intake staging CAS (sha256-named).
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`))).toBe(true)
    // pre-accept zero authority: no Project artifact, no Gate.
    expect(kernel.listArtifacts(projectId)).toHaveLength(0)
    expect(kernel.listGates(projectId)).toHaveLength(0)
    // intake status moved to uploading.
    const intake = kernel.listIntakes(projectId).find(i => i.intake_id === intakeId)!
    expect(intake.status).toBe('uploading')
  })

  it('whole-file sha256 mismatch vs expected → 422 and NO IntakeArtifact', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'w.bin', expected_size: 4, expected_sha256: 'f'.repeat(64) })
    kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('abcd'), contentRange: 'bytes 0-3/4', chunkSha256: sha256('abcd') })
    expectKernelError(() => kernel.finalizeUploadSession(intakeId, session.upload_id), 422, 'chunk_hash_mismatch')
    // staged bytes stay isolated; no artifact row.
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts').get()).toEqual({ n: 0 })
  })

  it('tampered staged bytes → 422 chunk_size_mismatch and no artifact', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 't.bin', expected_size: 4, chunk_size: 8 })
    kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('abcd'), contentRange: 'bytes 0-3/4', chunkSha256: sha256('abcd') })
    // Truncate the staged file behind the kernel's back.
    const partPath = join(kernel.intakeStagedRoot, intakeId, `${session.upload_id}.part`)
    writeFileSync(partPath, Buffer.from('abc'))
    expectKernelError(() => kernel.finalizeUploadSession(intakeId, session.upload_id), 422, 'chunk_size_mismatch')
  })

  it('repeated finalize returns the SAME artifact (idempotent replay)', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('0123456789')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'dup.bin')
    const again = kernel.finalizeUploadSession(intakeId, session.upload_id)
    expect(again.artifact_id).toBe(artifact.artifact_id)
    expect(again.sha256).toBe(sha256(content))
    const list = kernel.listUploadSessions(intakeId)[0]!
    expect(list.status).toBe('finalized')
    expect(list.finalized_sha256).toBe(sha256(content))
  })

  it('a close-time abort compensates a completed finalize only while its owned artifact is still staged', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('late-finalize')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'late.bin')
    const artifactPath = join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`)

    expect(kernel.db.prepare('SELECT owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ owns_artifact: 1 })
    expect(existsSync(artifactPath)).toBe(true)

    kernel.abortUploadSession(intakeId, session.upload_id)

    expect(kernel.listUploadSessions(intakeId)).toEqual([])
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts WHERE intake_id = ?').get(intakeId))
      .toEqual({ n: 0 })
    expect(existsSync(artifactPath)).toBe(false)
  })

  it('transfers staged-artifact ownership across deduplicated uploads and never retracts a scanned artifact', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('shared-content')
    const first = chunkedUpload(kernel, intakeId, content, 'first.txt')
    const second = chunkedUpload(kernel, intakeId, content, 'second.txt')

    kernel.abortUploadSession(intakeId, first.session.upload_id)
    expect(kernel.db.prepare('SELECT owns_artifact FROM upload_sessions WHERE upload_id = ?').get(second.session.upload_id))
      .toEqual({ owns_artifact: 1 })
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts WHERE intake_id = ?').get(intakeId))
      .toEqual({ n: 1 })

    kernel.scanIntake(intakeId)
    kernel.abortUploadSession(intakeId, second.session.upload_id)
    expect(kernel.db.prepare('SELECT quarantine FROM intake_artifacts WHERE intake_id = ?').get(intakeId))
      .toEqual({ quarantine: 'clean' })
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${first.artifact.sha256}.part`))).toBe(true)
  })

  it('preserves a failed artifact cleanup ledger across repeated abort and restart sweep', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('retry-cleanup')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'retry.bin')
    const internals = kernel as unknown as {
      removeIntakeStageFile: (targetIntakeId: string, sha: string) => boolean
    }
    const remove = internals.removeIntakeStageFile.bind(kernel)
    internals.removeIntakeStageFile = () => false

    kernel.abortUploadSession(intakeId, session.upload_id)
    expect(kernel.db.prepare('SELECT status, owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ status: 'aborted', owns_artifact: 1 })
    kernel.abortUploadSession(intakeId, session.upload_id)
    expect(kernel.db.prepare('SELECT status, owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ status: 'aborted', owns_artifact: 1 })

    internals.removeIntakeStageFile = remove
    expect(kernel.cleanupUploadSessions()).toBe(1)
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`))).toBe(false)
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ n: 0 })
  })

  it('never lets an old aborted ledger unlink a newly restaged same-SHA artifact', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('new-generation')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'old.bin')
    const internals = kernel as unknown as {
      removeIntakeStageFile: (targetIntakeId: string, sha: string) => boolean
    }
    const remove = internals.removeIntakeStageFile.bind(kernel)
    internals.removeIntakeStageFile = () => false
    kernel.abortUploadSession(intakeId, session.upload_id)
    internals.removeIntakeStageFile = remove

    const restaged = kernel.stageIntakeArtifact(intakeId, { file_name: 'new.bin', content })
    expect(restaged.sha256).toBe(artifact.sha256)
    expect(kernel.db.prepare('SELECT owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ owns_artifact: 0 })
    expect(kernel.cleanupUploadSessions()).toBe(1)
    const path = join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`)
    expect(readFileSync(path)).toEqual(content)
    expect(kernel.db.prepare('SELECT quarantine FROM intake_artifacts WHERE intake_id = ? AND sha256 = ?').get(intakeId, artifact.sha256))
      .toEqual({ quarantine: 'staged' })
  })

  it('treats direct same-SHA staging as an independent reference before upload abort', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('independent-reference')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'upload.bin')
    kernel.stageIntakeArtifact(intakeId, { file_name: 'direct.bin', content })
    expect(kernel.db.prepare('SELECT owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ owns_artifact: 0 })

    kernel.abortUploadSession(intakeId, session.upload_id)
    expect(kernel.db.prepare('SELECT quarantine FROM intake_artifacts WHERE intake_id = ? AND sha256 = ?').get(intakeId, artifact.sha256))
      .toEqual({ quarantine: 'staged' })
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`))).toBe(true)
  })

  it('finalized session feeds scanIntake → clean verdict, then the full intake pipeline works', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    // A real %PDF header so the magic check passes.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('x'.repeat(2048))])
    chunkedUpload(kernel, intakeId, pdf, 'paper.pdf')
    const projection = kernel.scanIntake(intakeId)
    const artifact = projection.artifacts[0]!
    expect(artifact.quarantine).toBe('clean')
    expect(projection.session.status).toBe('needs_input')
  })

  it('>32MiB chunked files scan with the streaming hash path (no whole-file buffering)', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    // 33 MiB of zeros with a .txt extension — allow-listed, no magic rule.
    const big = Buffer.alloc(33 * 1024 * 1024, 0x61)
    const { artifact } = chunkedUpload(kernel, intakeId, big, 'big.txt', sha256(big))
    expect(artifact.size_bytes).toBe(33 * 1024 * 1024)
    const projection = kernel.scanIntake(intakeId)
    expect(projection.artifacts[0]!.quarantine).toBe('clean')
  })
})

describe('CHUNK-01 abort + GC', () => {
  it('abort is idempotent and removes session rows + staged bytes', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'a.bin', expected_size: 100 })
    kernel.appendUploadChunk(intakeId, session.upload_id, { bytes: Buffer.from('0123'), contentRange: 'bytes 0-3/100', chunkSha256: sha256('0123') })
    const partPath = join(kernel.intakeStagedRoot, intakeId, `${session.upload_id}.part`)
    expect(existsSync(partPath)).toBe(true)
    kernel.abortUploadSession(intakeId, session.upload_id)
    expect(existsSync(partPath)).toBe(false)
    expect(kernel.listUploadSessions(intakeId)).toHaveLength(0)
    // Idempotent: aborting again (row gone) still returns ok.
    expect(kernel.abortUploadSession(intakeId, session.upload_id)).toEqual({ ok: true })
    // Quota released: a new session of the same size is accepted again.
    kernel.beginUploadSession(intakeId, { file_name: 'b.bin', expected_size: 100 })
  })

  it('cleanupUploadSessions GCs expired open sessions (≥24h) and frees quota', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'old.bin', expected_size: 50 })
    const partPath = join(kernel.intakeStagedRoot, intakeId, `${session.upload_id}.part`)
    writeFileSync(partPath, Buffer.from('0123456789'))
    // Age the session beyond its expiry directly.
    kernel.db.prepare('UPDATE upload_sessions SET expires_at = ? WHERE upload_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), session.upload_id)
    expect(kernel.cleanupUploadSessions()).toBe(1)
    expect(existsSync(partPath)).toBe(false)
    expect(kernel.listUploadSessions(intakeId)).toHaveLength(0)
    // A fresh session survives GC.
    kernel.beginUploadSession(intakeId, { file_name: 'fresh.bin', expected_size: 10 })
    expect(kernel.cleanupUploadSessions()).toBe(0)
  })

  it('recovers an aborted cleanup ledger left by a crash before filesystem unlink', () => {
    const kernel = freshKernel()
    const { intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, { file_name: 'pending-cleanup.bin', expected_size: 10 })
    kernel.appendUploadChunk(intakeId, session.upload_id, {
      bytes: Buffer.from('0123'), contentRange: 'bytes 0-3/10', chunkSha256: sha256('0123'),
    })
    const partPath = join(kernel.intakeStagedRoot, intakeId, `${session.upload_id}.part`)
    kernel.db.prepare("UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = ?").run(session.upload_id)

    expect(existsSync(partPath)).toBe(true)
    expect(kernel.cleanupUploadSessions()).toBe(1)
    expect(existsSync(partPath)).toBe(false)
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ n: 0 })
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ n: 0 })
  })

  it('durably tombstones a Chat scope, aborts its stages, and rejects every late Intake/begin', () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const session = kernel.beginUploadSession(intakeId, {
      file_name: 'late.bin', expected_size: 4, owner_scope_id: 's-exact-chat',
    })
    kernel.appendUploadChunk(intakeId, session.upload_id, {
      bytes: Buffer.from('0123'), contentRange: 'bytes 0-3/4', chunkSha256: sha256('0123'),
    })

    expect(kernel.tombstoneChatScope(projectId, 's-exact-chat')).toEqual({ ok: true, aborted_uploads: 1 })
    expect(kernel.listUploadSessions(intakeId)).toEqual([])
    expect(kernel.tombstoneChatScope(projectId, 's-exact-chat')).toEqual({ ok: true, aborted_uploads: 0 })
    expectKernelError(() => kernel.beginUploadSession(intakeId, {
      file_name: 'later.bin', expected_size: 1, owner_scope_id: 's-exact-chat',
    }), 409, 'chat_scope_closed')
    expectKernelError(() => kernel.beginIntake({
      project_id: projectId, source_label: 'late attachment intake', owner_scope_id: 's-exact-chat',
    }), 409, 'chat_scope_closed')
    expectKernelError(() => kernel.finalizeUploadSession(intakeId, session.upload_id), 404, 'upload_session_not_found')
  })

  it('atomically persists aborted ledgers before tombstone filesystem cleanup', () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const content = Buffer.from('crash-after-tombstone')
    const { artifact, session } = chunkedUpload(kernel, intakeId, content, 'crash.bin')
    kernel.db.prepare('UPDATE upload_sessions SET owner_scope_id = ? WHERE upload_id = ?')
      .run('s-crash-window', session.upload_id)
    const internals = kernel as unknown as {
      cleanupAbortedUpload: (targetIntakeId: string, uploadId: string) => boolean
    }
    const cleanup = internals.cleanupAbortedUpload.bind(kernel)
    internals.cleanupAbortedUpload = () => false

    expect(kernel.tombstoneChatScope(projectId, 's-crash-window')).toEqual({ ok: true, aborted_uploads: 1 })
    expect(kernel.db.prepare('SELECT status, owns_artifact FROM upload_sessions WHERE upload_id = ?').get(session.upload_id))
      .toEqual({ status: 'aborted', owns_artifact: 1 })
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts WHERE intake_id = ?').get(intakeId))
      .toEqual({ n: 0 })
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`))).toBe(true)

    internals.cleanupAbortedUpload = cleanup
    expect(kernel.cleanupUploadSessions()).toBe(1)
    expect(existsSync(join(kernel.intakeStagedRoot, intakeId, `${artifact.sha256}.part`))).toBe(false)
  })

  it('persists the owner scope on Chat-created Intake and rejects its idempotent replay after close', () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    kernel.db.prepare("UPDATE intake_sessions SET status = 'accepted' WHERE intake_id = ?").run(intakeId)
    const owned = kernel.beginIntake({
      project_id: projectId,
      source_label: 'Chat attachment intake',
      owner_scope_id: 's-owned-intake',
      idempotency_key: 'owned-intake-key',
      request_hash: 'owned-intake-hash',
    })
    expect(kernel.db.prepare('SELECT owner_scope_id FROM intake_sessions WHERE intake_id = ?').get(owned.intake_id))
      .toEqual({ owner_scope_id: 's-owned-intake' })
    expectKernelError(() => kernel.beginUploadSession(owned.intake_id, {
      file_name: 'wrong-scope.bin', expected_size: 1, owner_scope_id: 's-other-chat',
    }), 409, 'chat_scope_mismatch')
    const unscopedUpload = kernel.beginUploadSession(owned.intake_id, {
      file_name: 'human-takeover.bin', expected_size: 1,
    })
    expect(kernel.tombstoneChatScope(projectId, 's-owned-intake')).toEqual({ ok: true, aborted_uploads: 1 })
    expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE upload_id = ?').get(unscopedUpload.upload_id))
      .toEqual({ n: 0 })
    expectKernelError(() => kernel.stageIntakeArtifact(owned.intake_id, {
      file_name: 'late-direct.txt', content: 'must not stage',
    }), 409, 'chat_scope_closed')
    expectKernelError(() => kernel.beginUploadSession(owned.intake_id, {
      file_name: 'late-unscoped.bin', expected_size: 1,
    }), 409, 'chat_scope_closed')
    expectKernelError(() => kernel.beginIntake({
      project_id: projectId,
      source_label: 'Chat attachment intake',
      owner_scope_id: 's-owned-intake',
      idempotency_key: 'owned-intake-key',
      request_hash: 'owned-intake-hash',
    }), 409, 'chat_scope_closed')
    const replacement = kernel.beginIntake({
      project_id: projectId,
      source_label: 'Different Chat attachment intake',
      owner_scope_id: 's-other-chat',
    })
    expect(replacement.intake_id).not.toBe(owned.intake_id)
    expect(kernel.db.prepare('SELECT owner_scope_id FROM intake_sessions WHERE intake_id = ?').get(replacement.intake_id))
      .toEqual({ owner_scope_id: 's-other-chat' })
  })
})

describe('CHUNK-01 browser recovery projection', () => {
  it('rejects malformed successful begin and append responses with a stable protocol failure', async () => {
    const responses = [
      new Response(JSON.stringify({ upload_id: 'upl-bad' }), { status: 200 }),
      new Response(JSON.stringify({ committed_offset: '4', replayed: false }), { status: 200 }),
    ]
    const transport = browserTransport({
      baseImpl: () => 'https://scholar.invalid',
      authHeadersImpl: async () => ({}),
      csrfImpl: async () => undefined,
      fetchImpl: async () => responses.shift()!,
    })

    await expect(transport.beginSession({
      project_id: 'project-a', intake_id: 'intake-1', file_name: 'paper.pdf',
      media_type: 'application/pdf', expected_size: 4, expected_sha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.appendChunk({
      project_id: 'project-a', intake_id: 'intake-1', upload_id: 'upl-1',
      start: 0, end: 3, total: 4, bytes: new Uint8Array(4), sha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
  })

  it('rejects invalid JSON and out-of-bounds successful offsets as protocol failures', async () => {
    const identity = {
      intake_id: 'intake-1', project_id: 'project-a', file_name: 'paper.pdf', media_type: 'application/pdf',
      expected_size: 4, expected_sha256: 'a'.repeat(64),
    }
    const responses = [
      new Response('{', { status: 200 }),
      new Response(JSON.stringify({ ...identity, upload_id: 'upl-overflow', chunk_size: 4, committed_offset: 5 }), { status: 200 }),
      new Response('{', { status: 200 }),
    ]
    const transport = browserTransport({
      baseImpl: () => 'https://scholar.invalid',
      authHeadersImpl: async () => ({}),
      csrfImpl: async () => undefined,
      fetchImpl: async () => responses.shift()!,
    })
    const begin = {
      project_id: 'project-a', intake_id: 'intake-1', file_name: 'paper.pdf',
      media_type: 'application/pdf', expected_size: 4, expected_sha256: 'a'.repeat(64),
    }

    await expect(transport.beginSession(begin)).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.beginSession(begin)).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.appendChunk({
      project_id: 'project-a', intake_id: 'intake-1', upload_id: 'upl-1',
      start: 0, end: 3, total: 4, bytes: new Uint8Array(4), sha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
  })

  it('binds begin identity and accepts a valid replay beyond the retried range', async () => {
    const responses = [
      new Response(JSON.stringify({
        upload_id: 'upl-ok', intake_id: 'intake-1', project_id: 'project-a',
        file_name: 'paper.pdf', media_type: 'application/pdf', expected_size: 8,
        expected_sha256: 'a'.repeat(64), chunk_size: 4, committed_offset: 0,
      }), { status: 200 }),
      new Response(JSON.stringify({ upload_id: 'upl-ok', committed_offset: 8, replayed: true }), { status: 200 }),
    ]
    const transport = browserTransport({
      baseImpl: () => 'https://scholar.invalid', authHeadersImpl: async () => ({}),
      csrfImpl: async () => undefined, fetchImpl: async () => responses.shift()!,
    })

    await expect(transport.beginSession({
      project_id: 'project-a', intake_id: 'intake-1', file_name: 'paper.pdf',
      media_type: 'application/pdf', expected_size: 8, expected_sha256: 'a'.repeat(64),
    })).resolves.toMatchObject({ upload_id: 'upl-ok', committed_offset: 0 })
    await expect(transport.appendChunk({
      project_id: 'project-a', intake_id: 'intake-1', upload_id: 'upl-ok',
      start: 0, end: 3, total: 8, bytes: new Uint8Array(4), sha256: 'a'.repeat(64),
    })).resolves.toEqual({ upload_id: 'upl-ok', committed_offset: 8, replayed: true })
  })

  it('rejects complete 2xx responses whose begin or append identity is foreign', async () => {
    const identity = {
      upload_id: 'upl-ok', intake_id: 'intake-1', project_id: 'project-a',
      file_name: 'paper.pdf', media_type: 'application/pdf', expected_size: 4,
      expected_sha256: 'a'.repeat(64), chunk_size: 4, committed_offset: 0,
    }
    const responses = [
      new Response(JSON.stringify({ ...identity, project_id: 'foreign-project' }), { status: 200 }),
      new Response(JSON.stringify({ ...identity, intake_id: 'foreign-intake' }), { status: 200 }),
      new Response(JSON.stringify({ ...identity, file_name: 'foreign.pdf' }), { status: 200 }),
      new Response(JSON.stringify({ upload_id: 'upl-foreign', committed_offset: 4, replayed: false }), { status: 200 }),
    ]
    const transport = browserTransport({
      baseImpl: () => 'https://scholar.invalid', authHeadersImpl: async () => ({}),
      csrfImpl: async () => undefined, fetchImpl: async () => responses.shift()!,
    })

    const begin = {
      project_id: 'project-a', intake_id: 'intake-1', file_name: 'paper.pdf',
      media_type: 'application/pdf', expected_size: 4, expected_sha256: 'a'.repeat(64),
    }
    await expect(transport.beginSession(begin)).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.beginSession(begin)).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.beginSession(begin)).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
    await expect(transport.appendChunk({
      project_id: 'project-a', intake_id: 'intake-1', upload_id: 'upl-ok',
      start: 0, end: 3, total: 4, bytes: new Uint8Array(4), sha256: 'a'.repeat(64),
    })).rejects.toMatchObject({ failure: { code: 'upload_protocol_invalid' } })
  })

  it('keeps only bounded, internally consistent server sessions', async () => {
    const valid = {
      upload_id: 'upl-ok', intake_id: 'intake-1', file_name: 'paper.pdf', media_type: 'application/pdf',
      expected_size: 4, expected_sha256: 'a'.repeat(64), chunk_size: 2, committed_offset: 2, status: 'open',
    }
    const transport = browserTransport({
      baseImpl: () => 'https://scholar.invalid',
      authHeadersImpl: async () => ({}),
      csrfImpl: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify([
        valid,
        { ...valid, upload_id: 'upl-overflow', committed_offset: 5 },
        { ...valid, upload_id: 'upl-negative', committed_offset: -1 },
        { ...valid, upload_id: 'upl-bad-hash', expected_sha256: 'not-sha256' },
      ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    await expect(transport.listSessions?.({ project_id: 'project-a', intake_id: 'intake-1' }))
      .resolves.toEqual([valid])
  })
})

describe('CHUNK-01 HTTP surface (/v1/projects/{id}/intake/{iid}/upload-sessions*)', () => {
  it('begin → chunk PUT (raw bytes) → finalize → abort over HTTP', async () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const content = Buffer.from('hello chunked world!')
      // begin
      const begin = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: 'note.txt', expected_size: content.byteLength, chunk_size: 1024 }),
      })
      expect(begin.status).toBe(201)
      const session = (await begin.json()) as { upload_id: string; committed_offset: number }
      // chunk append (raw bytes)
      const chunk = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions/${session.upload_id}/chunks`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes 0-${content.byteLength - 1}/${content.byteLength}`,
          'x-chunk-sha256': sha256(content),
        },
        body: content,
      })
      expect(chunk.status).toBe(200)
      expect(((await chunk.json()) as { committed_offset: number }).committed_offset).toBe(content.byteLength)
      // finalize
      const fin = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions/${session.upload_id}/finalize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(fin.status).toBe(200)
      const artifact = (await fin.json()) as { artifact_id: string; sha256: string; quarantine: string }
      expect(artifact.sha256).toBe(sha256(content))
      expect(artifact.quarantine).toBe('staged')
      // list
      const list = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions`)
      expect(list.status).toBe(200)
      expect(((await list.json()) as Array<{ status: string }>)[0]!.status).toBe('finalized')
      // abort is idempotent (row gone → still ok)
      const abort = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions/${session.upload_id}/abort`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(abort.status).toBe(200)
      const abort2 = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions/${session.upload_id}/abort`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(abort2.status).toBe(200)
      // cross-project intake → 404 intake_not_found
      const foreign = await fetch(`${baseUrl}/v1/projects/rsp_nope/intake/${intakeId}/upload-sessions`)
      expect(foreign.status).toBe(404)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('chunk PUT with a wrong hash → 422 chunk_hash_mismatch over HTTP', async () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const begin = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: 'n.txt', expected_size: 4 }),
      })
      const session = (await begin.json()) as { upload_id: string }
      const chunk = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions/${session.upload_id}/chunks`, {
        method: 'PUT',
        headers: { 'content-range': 'bytes 0-3/4', 'x-chunk-sha256': 'f'.repeat(64) },
        body: Buffer.from('abcd'),
      })
      expect(chunk.status).toBe(422)
      const body = (await chunk.json()) as { error: { code: string } }
      expect(body.error.code).toBe('chunk_hash_mismatch')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('persists an exact Chat scope tombstone and rejects late HTTP upload work', async () => {
    const kernel = freshKernel()
    const { projectId, intakeId } = projectAndIntake(kernel)
    const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const scopeId = 's-http-close'
      const close = await fetch(`${baseUrl}/v1/projects/${projectId}/chat-scopes/${scopeId}/tombstone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(close.status).toBe(200)
      expect(await close.json()).toEqual({ ok: true, aborted_uploads: 0 })

      const begin = await fetch(`${baseUrl}/v1/projects/${projectId}/intake/${intakeId}/upload-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: 'late.txt', expected_size: 4, owner_scope_id: scopeId }),
      })
      expect(begin.status).toBe(409)
      expect(((await begin.json()) as { error: { code: string } }).error.code).toBe('chat_scope_closed')
      expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE owner_scope_id = ?').get(scopeId))
        .toEqual({ n: 0 })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

// ── 客户端队列状态机（PURE，无 DOM）──────────────────────────────────────

function baseItem(overrides: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    fileId: 'f1', fileName: 'paper.pdf', fileSize: 100, mediaType: 'application/pdf',
    state: 'queued', uploadId: null, intakeId: 'intk_1', projectId: 'rsp_1',
    expectedSha256: null, chunkSize: null, committedOffset: 0, retryCount: 0, lastError: null, ...overrides,
  }
}

describe('client queue model: per-file state machine + chunk ranges', () => {
  it('enqueueFiles starts every file in hashing; markHashed → queued with expected sha256', () => {
    const items = enqueueFiles([{ name: 'a.pdf', size: 10, type: 'application/pdf' }, { name: 'b.csv', size: 20 }])
    expect(items.map(i => i.state)).toEqual(['hashing', 'hashing'])
    const hashed = markHashed(items[0]!, 'ab'.repeat(32))
    expect(hashed.state).toBe('queued')
    expect(hashed.expectedSha256).toBe('ab'.repeat(32))
  })

  it('nextChunkRange slices [committed, committed+chunk-1] and returns null when done', () => {
    const item = baseItem({ fileSize: 10, committedOffset: 0 })
    expect(nextChunkRange(item, 4)).toEqual({ start: 0, end: 3 })
    expect(nextChunkRange({ ...item, committedOffset: 4 }, 4)).toEqual({ start: 4, end: 7 })
    expect(nextChunkRange({ ...item, committedOffset: 8 }, 4)).toEqual({ start: 8, end: 9 })
    expect(nextChunkRange({ ...item, committedOffset: 10 }, 4)).toBeNull()
  })

  it('pause/resume/retry transitions only from legal states', () => {
    const uploading = baseItem({ state: 'uploading', uploadId: 'upl_1' })
    expect(pauseItem(uploading).state).toBe('paused')
    expect(pauseItem(baseItem({ state: 'ready' })).state).toBe('ready')
    const resumed = resumeItem(pauseItem(uploading))
    expect(resumed.state).toBe('uploading')
    const failed = { ...uploading, state: 'failed' as const, lastError: uploadFailure('upload_failed') }
    const retried = retryItem(failed)
    expect(retried.state).toBe('uploading') // session kept → resume from committed offset
    expect(retried.retryCount).toBe(1)
    expect(retryItem(baseItem({ state: 'queued' })).state).toBe('queued')
  })

  it('queueSummary aggregates quota/progress/failures and derives the next step', () => {
    const done = baseItem({ fileName: 'a', fileSize: 10, committedOffset: 10, state: 'ready' })
    const uploading = baseItem({ fileName: 'b', fileSize: 20, committedOffset: 5, state: 'uploading' })
    const failed = baseItem({ fileName: 'c', fileSize: 30, committedOffset: 0, state: 'failed' })
    const summary = queueSummary([done, uploading, failed], 1024)
    expect(summary.totalBytes).toBe(60)
    expect(summary.committedBytes).toBe(15)
    expect(summary.remainingBytes).toBe(45)
    expect(summary.quotaBytes).toBe(1024)
    expect(summary.failedCount).toBe(1)
    expect(summary.nextStep).toBe('upload')
    const allDone = queueSummary([done], 1024)
    expect(allDone.nextStep).toBe('scan')
    const allCommittedWithFailure = queueSummary([{ ...done, state: 'failed' as const }], 1024)
    expect(allCommittedWithFailure.nextStep).toBe('confirm')
    expect(queueSummary([], 1024).nextStep).toBe('idle')
  })

  it('chatAttachmentRef carries only the stage ref (no bytes) with the queue state', () => {
    const staged = baseItem({ uploadId: 'upl_1', committedOffset: 100, state: 'scanning' })
    const ref = chatAttachmentRef(staged)!
    expect(ref).toEqual({
      kind: 'intake-upload', upload_id: 'upl_1', intake_id: 'intk_1', project_id: 'rsp_1',
      file_name: 'paper.pdf', state: 'staged',
    })
    expect(chatAttachmentRef(baseItem())).toBeNull() // no session yet → no ref
  })
})

describe('client driveUpload: full lifecycle with an injected fake transport', () => {
  interface FakeSession { upload_id: string; chunks: Array<{ start: number; bytes: Uint8Array; sha256: string }>; finalized: boolean }

  function fakeTransport(state: { sessions: FakeSession[]; failAppends: number }): UploadTransport {
    return {
      async beginSession(input) {
        const session: FakeSession = { upload_id: `upl_${state.sessions.length + 1}`, chunks: [], finalized: false }
        state.sessions.push(session)
        return beginResult(input, session.upload_id)
      },
      async appendChunk(input) {
        if (state.failAppends > 0) {
          state.failAppends -= 1
          throw new Error('network blip')
        }
        const session = state.sessions.find(s => s.upload_id === input.upload_id)!
        session.chunks.push({ start: input.start, bytes: input.bytes, sha256: input.sha256 })
        return { upload_id: input.upload_id, committed_offset: input.end + 1, replayed: false }
      },
      async finalize(input) {
        const session = state.sessions.find(s => s.upload_id === input.upload_id)!
        session.finalized = true
        return { artifact_id: `sha256:${session.chunks[0]?.sha256 ?? ''}` }
      },
      async abort() { return { ok: true } },
    }
  }

  it('hashes → begins → appends every chunk → finalizes → scanning', async () => {
    const file = Buffer.from('0123456789abcdef') // 16 bytes
    const item = markHashed(baseItem({ fileSize: 16, expectedSha256: null }), sha256(file))
    const state: { sessions: FakeSession[]; failAppends: number } = { sessions: [], failAppends: 0 }
    const transport = fakeTransport(state)
    const states: string[] = []
    const final = await driveUpload(item, transport, {
      chunkSize: 4,
      onState: (next) => { states.push(next.state) },
      readBytes: async (_fid, start, end) => file.subarray(start, end + 1),
    })
    expect(final.state).toBe('scanning')
    expect(final.committedOffset).toBe(16)
    expect(final.uploadId).toBe('upl_1')
    expect(state.sessions).toHaveLength(1)
    const session = state.sessions[0]!
    expect(session.chunks.map(c => c.start)).toEqual([0, 4, 8, 12])
    expect(session.chunks.every(c => c.sha256 === sha256(c.bytes))).toBe(true)
    expect(session.finalized).toBe(true)
    // 状态推进顺序覆盖 begin→uploading→finalizing→scanning。
    expect(states).toContain('uploading')
    expect(states).toContain('finalizing')
    expect(states[states.length - 1]).toBe('scanning')
  })

  it('retries transient append failures up to maxRetries, then fails honestly', async () => {
    const file = Buffer.from('0123456789abcdef')
    const item = markHashed(baseItem({ fileSize: 16 }), sha256(file))
    const state: { sessions: FakeSession[]; failAppends: number } = { sessions: [], failAppends: 1 }
    const transport = fakeTransport(state)
    const final = await driveUpload(item, transport, { chunkSize: 4, maxRetries: 3, readBytes: async (_f, s, e) => file.subarray(s, e + 1) })
    expect(final.state).toBe('scanning') // transient blip recovered
    expect(state.sessions[0]!.chunks.length).toBe(4)
    // Persistent failure → failed with the last error, offset preserved for retry.
    const item2 = markHashed(baseItem({ fileId: 'f2', fileSize: 16 }), sha256(file))
    const state2: { sessions: FakeSession[]; failAppends: number } = { sessions: [], failAppends: 99 }
    const final2 = await driveUpload(item2, fakeTransport(state2), { chunkSize: 4, maxRetries: 2, readBytes: async (_f, s, e) => file.subarray(s, e + 1) })
    expect(final2.state).toBe('failed')
    expect(final2.retryCount).toBe(0)
    expect(final2.lastError).toEqual({ code: 'upload_chunk_failed' })
  })

  it('converts browser chunk-read failures into a stable failed queue state', async () => {
    const item = markHashed(baseItem({ fileSize: 4 }), sha256('data'))
    const state: { sessions: FakeSession[]; failAppends: number } = { sessions: [], failAppends: 0 }

    const result = await driveUpload(item, fakeTransport(state), {
      chunkSize: 4,
      readBytes: async () => { throw new Error('raw browser read failure') },
    })

    expect(result).toMatchObject({ state: 'failed', lastError: { code: 'upload_chunk_failed' } })
    expect(state.sessions[0]?.chunks).toEqual([])
  })

  it('stops instead of repeating a chunk when the server offset regresses', async () => {
    const file = Buffer.from('01234567')
    const item = markHashed(baseItem({ fileSize: 8, committedOffset: 4, uploadId: 'upl-1' }), sha256(file))
    let appends = 0
    const transport: UploadTransport = {
      async beginSession() { throw new Error('existing upload must not begin') },
      async appendChunk(input) { appends += 1; return { upload_id: input.upload_id, committed_offset: 3, replayed: false } },
      async finalize() { throw new Error('regressed upload must not finalize') },
      async abort() {},
    }

    const result = await driveUpload(item, transport, {
      chunkSize: 4,
      readBytes: async (_fileId, start, end) => file.subarray(start, end + 1),
    })

    expect(result).toMatchObject({ state: 'failed', lastError: { code: 'upload_offset_regressed' } })
    expect(appends).toBe(1)
  })

  it('accepts a replayed authoritative offset beyond the requested old range', async () => {
    const file = Buffer.from('01234567')
    const item = markHashed(baseItem({ fileSize: 8, uploadId: 'upl-1' }), sha256(file))
    let appends = 0
    let finalized = false
    const transport: UploadTransport = {
      async beginSession() { throw new Error('existing upload must not begin') },
      async appendChunk(input) {
        appends += 1
        return { upload_id: input.upload_id, committed_offset: 8, replayed: true }
      },
      async finalize() { finalized = true },
      async abort() {},
    }

    const result = await driveUpload(item, transport, {
      chunkSize: 4,
      readBytes: async (_fileId, start, end) => file.subarray(start, end + 1),
    })

    expect(result).toMatchObject({ state: 'scanning', committedOffset: 8 })
    expect(appends).toBe(1)
    expect(finalized).toBe(true)
  })

  it('does not retry an injected successful append response with a foreign identity', async () => {
    const file = Buffer.from('0123')
    const item = markHashed(baseItem({ fileSize: 4, uploadId: 'upl-1' }), sha256(file))
    let appends = 0
    const transport: UploadTransport = {
      async beginSession() { throw new Error('existing upload must not begin') },
      async appendChunk(input) {
        appends += 1
        return { upload_id: 'upl-foreign', committed_offset: input.end + 1, replayed: false }
      },
      async finalize() { throw new Error('invalid response must not finalize') },
      async abort() {},
    }

    const result = await driveUpload(item, transport, {
      maxRetries: 3,
      readBytes: async () => file,
    })

    expect(result).toMatchObject({ state: 'failed', lastError: { code: 'upload_protocol_invalid' } })
    expect(appends).toBe(1)
  })

  it('resumes from a validated begin offset and rejects malformed injected begin data', async () => {
    const file = Buffer.from('01234567')
    const item = markHashed(baseItem({ fileSize: 8 }), sha256(file))
    const starts: number[] = []
    const transport: UploadTransport = {
      async beginSession(input) { return beginResult(input, 'upl-resume', 4, 4) },
      async appendChunk(input) {
        starts.push(input.start)
        return { upload_id: input.upload_id, committed_offset: input.end + 1, replayed: false }
      },
      async finalize() {},
      async abort() {},
    }
    const resumed = await driveUpload(item, transport, {
      readBytes: async (_id, start, end) => file.subarray(start, end + 1),
    })
    expect(resumed.state).toBe('scanning')
    expect(starts).toEqual([4])

    const malformed: UploadTransport = {
      ...transport,
      async beginSession(input) { return beginResult(input, '', 0, 4) },
    }
    await expect(driveUpload(item, malformed, {
      readBytes: async (_id, start, end) => file.subarray(start, end + 1),
    })).resolves.toMatchObject({ state: 'failed', lastError: { code: 'upload_protocol_invalid' } })

    const foreign: UploadTransport = {
      ...transport,
      async beginSession(input) { return { ...beginResult(input, 'upl-foreign', 0, 4), project_id: 'foreign-project' } },
    }
    await expect(driveUpload(item, foreign, {
      readBytes: async (_id, start, end) => file.subarray(start, end + 1),
    })).resolves.toMatchObject({ state: 'failed', lastError: { code: 'upload_protocol_invalid' } })
  })

  it('shouldContinue=false pauses mid-upload; resume continues from the committed offset', async () => {
    const file = Buffer.from('0123456789abcdef')
    const item = markHashed(baseItem({ fileSize: 16 }), sha256(file))
    const state: { sessions: FakeSession[]; failAppends: number } = { sessions: [], failAppends: 0 }
    const transport = fakeTransport(state)
    // Pause AFTER the first chunk lands (committed 4): the driver checks
    // shouldContinue before each chunk.
    const pausedItem = await driveUpload(item, transport, {
      chunkSize: 4,
      readBytes: async (_f, s, e) => file.subarray(s, e + 1),
      shouldContinue: (cur) => cur.committedOffset < 4,
    })
    expect(pausedItem.state).toBe('paused')
    expect(pausedItem.committedOffset).toBe(4) // paused after chunk 0
    // resume: allow the rest to flow (uploadId kept → continues from the offset).
    const resumed = await driveUpload(resumeItem(pausedItem), transport, {
      chunkSize: 4,
      readBytes: async (_f, s, e) => file.subarray(s, e + 1),
    })
    expect(resumed.state).toBe('scanning')
    expect(resumed.committedOffset).toBe(16)
  })

  it('preserves a pause requested while appendChunk is in flight', async () => {
    const file = Buffer.from('01234567')
    const item = markHashed(baseItem({ fileSize: 8 }), sha256(file))
    let paused = false
    let releaseAppend: ((result: { upload_id: string; committed_offset: number; replayed: boolean }) => void) | undefined
    let signalAppendStarted: (() => void) | undefined
    const appendStarted = new Promise<void>(resolve => { signalAppendStarted = resolve })
    let appends = 0
    const transport: UploadTransport = {
      async beginSession(input) { return beginResult(input, 'upl_1', 0, 4) },
      appendChunk() {
        appends += 1
        signalAppendStarted?.()
        return new Promise(resolve => { releaseAppend = resolve })
      },
      async finalize() { throw new Error('must not finalize while paused') },
      async abort() {},
    }
    const pending = driveUpload(item, transport, {
      chunkSize: 4,
      readBytes: async (_f, start, end) => file.subarray(start, end + 1),
      shouldContinue: () => !paused,
    })
    await appendStarted
    paused = true
    releaseAppend!({ upload_id: 'upl_1', committed_offset: 4, replayed: false })
    const result = await pending

    expect(result).toMatchObject({ state: 'paused', committedOffset: 4 })
    expect(appends).toBe(1)
  })

  it('honours the server-negotiated chunk cap and persists it in the queue item', async () => {
    const file = Buffer.from('0123456789')
    const item = markHashed(baseItem({ fileSize: file.byteLength }), sha256(file))
    const ranges: Array<[number, number]> = []
    const transport: UploadTransport = {
      async beginSession(input) { return beginResult(input, 'upl_1', 0, 3) },
      async appendChunk(input) {
        ranges.push([input.start, input.end])
        expect(input.bytes.byteLength).toBeLessThanOrEqual(3)
        return { upload_id: input.upload_id, committed_offset: input.end + 1, replayed: false }
      },
      async finalize() {},
      async abort() {},
    }

    const result = await driveUpload(item, transport, {
      chunkSize: 8,
      readBytes: async (_fileId, start, end) => file.subarray(start, end + 1),
    })

    expect(result).toMatchObject({ state: 'scanning', chunkSize: 3 })
    expect(ranges).toEqual([[0, 2], [3, 5], [6, 8], [9, 9]])
  })

  it('preserves begin-in-flight pause and aborts a server session rejected by its owner', async () => {
    const file = Buffer.from('0123')
    const item = markHashed(baseItem({ fileSize: file.byteLength }), sha256(file))
    let paused = false
    let acceptState = true
    let releaseBegin: ((session: UploadBeginResult) => void) | undefined
    let beginInput: UploadBeginRequest | undefined
    const aborted: string[] = []
    const transport: UploadTransport = {
      beginSession: input => {
        beginInput = input
        return new Promise(resolve => { releaseBegin = resolve })
      },
      async appendChunk() { throw new Error('must not append while paused') },
      async finalize() { throw new Error('must not finalize while paused') },
      async abort(input) { aborted.push(input.upload_id) },
    }
    const pending = driveUpload(item, transport, {
      readBytes: async () => file,
      shouldContinue: () => !paused,
      onState: () => acceptState,
    })
    paused = true
    releaseBegin!(beginResult(beginInput!, 'upl-paused', 0, 2))
    await expect(pending).resolves.toMatchObject({ state: 'paused', uploadId: 'upl-paused', chunkSize: 2 })
    expect(aborted).toEqual([])

    paused = false
    acceptState = false
    const rejected = driveUpload(item, transport, {
      readBytes: async () => file,
      shouldContinue: () => true,
      onState: () => acceptState,
    })
    releaseBegin!(beginResult(beginInput!, 'upl-orphan', 0, 2))
    await rejected
    expect(aborted).toEqual(['upl-orphan'])
  })

  it('compensates a finalize that completes after its exact Chat session is cancelled', async () => {
    const controller = new AbortController()
    let signalFinalizeStarted: (() => void) | undefined
    let releaseFinalize: (() => void) | undefined
    const finalizeStarted = new Promise<void>(resolve => { signalFinalizeStarted = resolve })
    const aborted: string[] = []
    const transport: UploadTransport = {
      async beginSession() { throw new Error('existing upload must not begin again') },
      async appendChunk() { throw new Error('fully uploaded item must not append') },
      finalize: () => {
        signalFinalizeStarted?.()
        return new Promise<void>(resolve => { releaseFinalize = resolve })
      },
      async abort(input) { aborted.push(input.upload_id) },
    }
    const item = baseItem({
      state: 'uploading', uploadId: 'upl-finalizing', fileSize: 4, committedOffset: 4,
      expectedSha256: sha256('0123'),
    })
    const states: string[] = []
    const pending = driveUpload(item, transport, {
      signal: controller.signal,
      onState: next => { states.push(next.state) },
    })

    await finalizeStarted
    controller.abort()
    releaseFinalize?.()
    const result = await pending

    expect(result.state).toBe('finalizing')
    expect(states).not.toContain('scanning')
    expect(aborted).toEqual(['upl-finalizing'])
  })
})
