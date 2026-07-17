import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { CertAuthority } from './CertAuthority'

// baseDir inyectado: cada test corre en su propio tmp, nada toca ~/.evermore-profiler.
const dirs: string[] = []
function freshBaseDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'evermore-ca-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('CertAuthority.ensureRootCA', () => {
  test('genera una CA self-signed con basicConstraints cA:true', async () => {
    const ca = new CertAuthority(freshBaseDir())
    const { certPem, keyPem } = await ca.ensureRootCA()

    expect(certPem).toContain('BEGIN CERTIFICATE')
    expect(keyPem).toContain('BEGIN RSA PRIVATE KEY')

    const cert = forge.pki.certificateFromPem(certPem)
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | undefined
    expect(bc?.cA).toBe(true)
    // self-signed: la CA se verifica a sí misma
    expect(cert.verify(cert)).toBe(true)
  })

  test('es idempotente: dos llamadas reusan la MISMA CA (no re-genera)', async () => {
    const baseDir = freshBaseDir()
    const first = await new CertAuthority(baseDir).ensureRootCA()
    // instancia nueva sobre el mismo baseDir: debe releer del disco
    const second = await new CertAuthority(baseDir).ensureRootCA()

    expect(second.certPem).toBe(first.certPem)
    expect(second.keyPem).toBe(first.keyPem)
  })

  test('persiste la key con permisos 0600', async () => {
    const baseDir = freshBaseDir()
    const ca = new CertAuthority(baseDir)
    await ca.ensureRootCA()

    const keyPath = join(baseDir, 'ca', 'ca.key.pem')
    const mode = statSync(keyPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('CertAuthority.certForHost', () => {
  test('emite un leaf con SAN = host, firmado por la CA', async () => {
    const ca = new CertAuthority(freshBaseDir())
    const { certPem: caPem } = await ca.ensureRootCA()
    const caCert = forge.pki.certificateFromPem(caPem)

    const leaf = await ca.certForHost('api.evermore.example')
    const leafCert = forge.pki.certificateFromPem(leaf.certPem)

    // SAN incluye el host
    const san = leafCert.getExtension('subjectAltName') as
      { altNames?: Array<{ type: number; value: string }> } | undefined
    const dnsNames = (san?.altNames ?? []).filter((a) => a.type === 2).map((a) => a.value)
    expect(dnsNames).toContain('api.evermore.example')

    // firmado por la CA (la CA verifica al hijo)
    expect(caCert.verify(leafCert)).toBe(true)
    // el leaf NO es CA
    const bc = leafCert.getExtension('basicConstraints') as { cA?: boolean } | undefined
    expect(bc?.cA ?? false).toBe(false)
  })

  test('cachea por host: dos llamadas devuelven el mismo cert', async () => {
    const ca = new CertAuthority(freshBaseDir())
    await ca.ensureRootCA()
    const a = await ca.certForHost('host.example')
    const b = await ca.certForHost('host.example')
    expect(b.certPem).toBe(a.certPem)
    expect(b.keyPem).toBe(a.keyPem)
  })

  test('el cache sobrevive a una instancia nueva (persistido en ca/certs/<host>.pem)', async () => {
    const baseDir = freshBaseDir()
    const first = await new CertAuthority(baseDir)
      .ensureRootCA()
      .then(() => new CertAuthority(baseDir).certForHost('persist.example'))
    // hack: reusar el mismo baseDir con una CA fresca no debe re-emitir
    const ca2 = new CertAuthority(baseDir)
    await ca2.ensureRootCA()
    const again = await ca2.certForHost('persist.example')
    expect(again.certPem).toBe(first.certPem)
  })

  test('certForHost sin ensureRootCA previo levanta la CA sola', async () => {
    const ca = new CertAuthority(freshBaseDir())
    const leaf = await ca.certForHost('lazy.example')
    expect(leaf.certPem).toContain('BEGIN CERTIFICATE')
  })
})

describe('CertAuthority.rootCertPath', () => {
  test('apunta al ca.cert.pem dentro del baseDir', async () => {
    const baseDir = freshBaseDir()
    const ca = new CertAuthority(baseDir)
    await ca.ensureRootCA()
    expect(ca.rootCertPath()).toBe(join(baseDir, 'ca', 'ca.cert.pem'))
  })
})
