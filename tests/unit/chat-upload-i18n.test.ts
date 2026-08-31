import { afterEach, describe, expect, it } from 'vitest'
import { uploadErrorText } from '../../packages/dsh-research-ui/src/client/chat-attachments'
import { uploadFailure } from '../../packages/dsh-research-ui/src/client/chunked-upload'
import { setLocale } from '../../packages/dsh-research-ui/src/client/i18n/index'

afterEach(() => { setLocale('zh') })

describe('localized Chat upload failures', () => {
  it('renders transport status without leaking raw English in Chinese', () => {
    setLocale('zh')
    const text = uploadErrorText(uploadFailure('upload_begin_failed', 409))
    expect(text).toContain('409')
    expect(text).toContain('上传')
    expect(text).not.toContain('begin upload session failed')
  })

  it('renders the same stable code in English and hides unknown raw prose', () => {
    setLocale('en')
    expect(uploadErrorText(uploadFailure('upload_finalize_failed', 503))).toMatch(/503.*retry/i)
    expect(uploadErrorText(uploadFailure('upload_failed'))).toMatch(/failed.*retry/i)
  })

  it('omits the HTTP marker when no transport status exists', () => {
    setLocale('zh')
    expect(uploadErrorText(uploadFailure('upload_chunk_failed'))).not.toContain('HTTP')
    setLocale('en')
    expect(uploadErrorText(uploadFailure('upload_chunk_failed'))).not.toContain('HTTP')
  })
})
