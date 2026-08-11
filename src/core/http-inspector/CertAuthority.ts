// CertAuthority (ticket 019): emisión de la CA raíz + leaf certs por-host con
// node-forge. El MITM proxy (018) usa estos certs para hacerse pasar por cada
// host. Verdicto del spike R1 (Bun 1.3.11): `SNICallback` NO dispara, así que
// los certs se emiten de forma EAGER (certForHost, cacheados) — nunca dentro
// del callback TLS. Este módulo es device-independent: sólo cripto + FS.
//
// baseDir se inyecta (no hardcodeamos homedir) para poder testear en tmp. En
// producción el llamador pasa `~/.evermore-profiler`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import forge from 'node-forge'

export interface CertPair {
  certPem: string
  keyPem: string
}

const CA_SUBJECT = [
  { name: 'commonName', value: 'Evermore Profiler CA' },
  { name: 'organizationName', value: 'Odaclick' },
  { shortName: 'OU', value: 'Evermore Mobile Profiler' },
]

/** 10 años: la CA se instala una vez por device y sirve para siempre. */
const CA_VALIDITY_YEARS = 10
/** Los leaf certs son de vida corta pero holgada; no se re-instalan. */
const LEAF_VALIDITY_YEARS = 2

export class CertAuthority {
  private readonly caDir: string
  private readonly certsDir: string
  private readonly caCertPath: string
  private readonly caKeyPath: string
  private readonly hostCache = new Map<string, CertPair>()
  // La key es siempre RSA (la generamos / releemos como RSA); tipada como
  // rsa.PrivateKey porque es lo que pide cert.sign().
  private root: {
    cert: forge.pki.Certificate
    key: forge.pki.rsa.PrivateKey
    pair: CertPair
  } | null = null

  constructor(baseDir: string) {
    this.caDir = join(baseDir, 'ca')
    this.certsDir = join(this.caDir, 'certs')
    this.caCertPath = join(this.caDir, 'ca.cert.pem')
    this.caKeyPath = join(this.caDir, 'ca.key.pem')
  }

  /** Genera la CA raíz una sola vez y la persiste; relee si ya existe. Idempotente. */
  async ensureRootCA(): Promise<CertPair> {
    if (this.root) return this.root.pair

    if (existsSync(this.caCertPath) && existsSync(this.caKeyPath)) {
      const certPem = readFileSync(this.caCertPath, 'utf8')
      const keyPem = readFileSync(this.caKeyPath, 'utf8')
      this.root = {
        cert: forge.pki.certificateFromPem(certPem),
        key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
        pair: { certPem, keyPem },
      }
      return this.root.pair
    }

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = randomSerial()
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000)
    cert.validity.notAfter = yearsFromNow(CA_VALIDITY_YEARS)
    cert.setSubject(CA_SUBJECT)
    cert.setIssuer(CA_SUBJECT)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())

    const certPem = forge.pki.certificateToPem(cert)
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey)

    mkdirSync(this.caDir, { recursive: true })
    writeFileSync(this.caCertPath, certPem, { mode: 0o644 })
    // key con permisos 0600 (private) — el mode del open no siempre gana si el
    // archivo ya existía, pero acá recién lo creamos.
    writeFileSync(this.caKeyPath, keyPem, { mode: 0o600 })

    this.root = { cert, key: keys.privateKey, pair: { certPem, keyPem } }
    return this.root.pair
  }

  /** Emite (o relee del cache) un leaf con SAN=host firmado por la CA. */
  async certForHost(host: string): Promise<CertPair> {
    const cached = this.hostCache.get(host)
    if (cached) return cached

    const root = await this.ensureRoot()

    const hostPath = join(this.certsDir, `${sanitizeHost(host)}.pem`)
    const keyPath = join(this.certsDir, `${sanitizeHost(host)}.key.pem`)
    if (existsSync(hostPath) && existsSync(keyPath)) {
      const pair: CertPair = {
        certPem: readFileSync(hostPath, 'utf8'),
        keyPem: readFileSync(keyPath, 'utf8'),
      }
      this.hostCache.set(host, pair)
      return pair
    }

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = randomSerial()
    cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000)
    cert.validity.notAfter = yearsFromNow(LEAF_VALIDITY_YEARS)
    cert.setSubject([{ name: 'commonName', value: host }])
    cert.setIssuer(root.cert.subject.attributes)
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
    ])
    cert.sign(root.key, forge.md.sha256.create())

    const pair: CertPair = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    }

    mkdirSync(this.certsDir, { recursive: true })
    writeFileSync(hostPath, pair.certPem, { mode: 0o644 })
    writeFileSync(keyPath, pair.keyPem, { mode: 0o600 })
    this.hostCache.set(host, pair)
    return pair
  }

  /** Ruta del ca.cert.pem a pushear/instalar en el device (018). */
  rootCertPath(): string {
    return this.caCertPath
  }

  private async ensureRoot(): Promise<{
    cert: forge.pki.Certificate
    key: forge.pki.rsa.PrivateKey
    pair: CertPair
  }> {
    if (!this.root) await this.ensureRootCA()
    // ensureRootCA siempre setea this.root
    return this.root!
  }
}

function yearsFromNow(years: number): Date {
  const d = new Date()
  d.setFullYear(d.getFullYear() + years)
  return d
}

/** Serial hex aleatorio positivo (16 bytes). */
function randomSerial(): string {
  return '00' + forge.util.bytesToHex(forge.random.getBytesSync(16))
}

/** Sanea el host para nombre de archivo (`:` de puertos, wildcards, etc.). */
function sanitizeHost(host: string): string {
  return host.replace(/[^a-zA-Z0-9._-]/g, '_')
}
