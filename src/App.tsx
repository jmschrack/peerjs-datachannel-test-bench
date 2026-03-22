import { useEffect, useRef, useState } from 'react'
import Peer, { type DataConnection } from 'peerjs'
import './App.css'

const CHUNK_SIZE = 64 * 1024
const ID_LENGTH = 9
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

type TransferMeta = {
  type: 'meta'
  fileName: string
  mimeType: string
  size: number
  totalChunks: number
}

type TransferDone = {
  type: 'done'
}

type PingMessage = {
  type: 'ping'
  probeId: number
}

type PongMessage = {
  type: 'pong'
  probeId: number
}

type ControlMessage = TransferMeta | TransferDone | PingMessage | PongMessage

type ReceivedFile = {
  name: string
  size: number
  mimeType: string
  url: string
}

function randomPeerId(): string {
  let result = ''
  for (let index = 0; index < ID_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * ALPHANUMERIC.length)
    result += ALPHANUMERIC[randomIndex]
  }
  return result
}

function normalizePeerId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ID_LENGTH)
}

function isValidPeerId(value: string): boolean {
  return /^[A-Z0-9]{9}$/.test(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) {
    return data
  }

  if (data instanceof Blob) {
    return data.arrayBuffer()
  }

  if (data instanceof Uint8Array) {
    const copied = new Uint8Array(data.byteLength)
    copied.set(data)
    return copied.buffer
  }

  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function App() {
  const peerRef = useRef<Peer | null>(null)
  const connectionRef = useRef<DataConnection | null>(null)
  const connectionOpenedAtRef = useRef<number | null>(null)
  const pendingPingRef = useRef<Map<number, number>>(new Map())
  const receiveMetaRef = useRef<TransferMeta | null>(null)
  const receiveBuffersRef = useRef<ArrayBuffer[]>([])
  const receiveBytesRef = useRef<number>(0)

  const [localPeerId, setLocalPeerId] = useState<string>(randomPeerId())
  const [remotePeerIdInput, setRemotePeerIdInput] = useState<string>('')
  const [peerOnline, setPeerOnline] = useState<boolean>(false)
  const [connectionOpen, setConnectionOpen] = useState<boolean>(false)
  const [connectionTarget, setConnectionTarget] = useState<string>('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isSending, setIsSending] = useState<boolean>(false)
  const [sendProgress, setSendProgress] = useState<number>(0)
  const [isReceiving, setIsReceiving] = useState<boolean>(false)
  const [receiveProgress, setReceiveProgress] = useState<number>(0)
  const [receivedFile, setReceivedFile] = useState<ReceivedFile | null>(null)
  const [activityLog, setActivityLog] = useState<string[]>([])
  const [sentBytes, setSentBytes] = useState<number>(0)
  const [receivedBytes, setReceivedBytes] = useState<number>(0)
  const [lastPingMs, setLastPingMs] = useState<number | null>(null)
  const [avgPingMs, setAvgPingMs] = useState<number | null>(null)
  const [pingCount, setPingCount] = useState<number>(0)
  const [, setUptimeTick] = useState<number>(0)

  const appendLog = (message: string): void => {
    setActivityLog((previous) => {
      const timestamp = new Date().toLocaleTimeString()
      return [`${timestamp} - ${message}`, ...previous].slice(0, 10)
    })
  }

  const clearConnection = (): void => {
    if (connectionRef.current) {
      connectionRef.current.close()
      connectionRef.current = null
    }
    connectionOpenedAtRef.current = null
    pendingPingRef.current.clear()
    setConnectionOpen(false)
    setConnectionTarget('')
    setIsSending(false)
    setSendProgress(0)
    setLastPingMs(null)
    setAvgPingMs(null)
    setPingCount(0)
    setUptimeTick(0)
  }

  const clearIncomingFile = (): void => {
    if (receivedFile) {
      URL.revokeObjectURL(receivedFile.url)
    }
    setReceivedFile(null)
  }

  const resetReceiveState = (): void => {
    receiveMetaRef.current = null
    receiveBuffersRef.current = []
    receiveBytesRef.current = 0
    setReceivedBytes(0)
    setIsReceiving(false)
    setReceiveProgress(0)
  }

  const handleIncomingControlMessage = (raw: string): void => {
    let message: ControlMessage

    try {
      message = JSON.parse(raw) as ControlMessage
    } catch {
      appendLog('Ignored invalid control message.')
      return
    }

    if (message.type === 'meta') {
      clearIncomingFile()
      resetReceiveState()
      receiveMetaRef.current = message
      setIsReceiving(true)
      appendLog(
        `Receiving ${message.fileName} (${(message.size / (1024 * 1024)).toFixed(2)} MB).`,
      )
      return
    }

    if (message.type === 'ping') {
      const connection = connectionRef.current
      if (connection?.open) {
        const response: PongMessage = { type: 'pong', probeId: message.probeId }
        connection.send(JSON.stringify(response))
      }
      return
    }

    if (message.type === 'pong') {
      const sentAt = pendingPingRef.current.get(message.probeId)
      if (typeof sentAt === 'number') {
        pendingPingRef.current.delete(message.probeId)
        const rtt = performance.now() - sentAt
        setLastPingMs(rtt)
        setPingCount((previousCount) => {
          const nextCount = previousCount + 1
          setAvgPingMs((previousAvg) => {
            if (previousAvg === null) {
              return rtt
            }

            return ((previousAvg * previousCount) + rtt) / nextCount
          })
          return nextCount
        })
      }
      return
    }

    if (message.type === 'done') {
      const meta = receiveMetaRef.current
      if (!meta) {
        appendLog('Received completion signal without file metadata.')
        return
      }

      const blob = new Blob(receiveBuffersRef.current, { type: meta.mimeType })
      const url = URL.createObjectURL(blob)
      setReceivedFile({
        name: meta.fileName,
        size: meta.size,
        mimeType: meta.mimeType,
        url,
      })
      setIsReceiving(false)
      setReceiveProgress(100)
      appendLog(`Finished receiving ${meta.fileName}.`)
    }
  }

  const handleIncomingBinary = async (chunk: unknown): Promise<void> => {
    const buffer = await toArrayBuffer(chunk)
    if (!buffer) {
      appendLog('Ignored unsupported incoming chunk type.')
      return
    }

    receiveBuffersRef.current.push(buffer)
    receiveBytesRef.current += buffer.byteLength
    setReceivedBytes(receiveBytesRef.current)

    const meta = receiveMetaRef.current
    if (meta && meta.size > 0) {
      const progress = Math.min((receiveBytesRef.current / meta.size) * 100, 100)
      setReceiveProgress(progress)
    }
  }

  const bindConnection = (connection: DataConnection): void => {
    if (connectionRef.current && connectionRef.current.open) {
      connectionRef.current.close()
    }

    connectionRef.current = connection
    setConnectionTarget(connection.peer)

    connection.on('open', () => {
      connectionOpenedAtRef.current = Date.now()
      setConnectionOpen(true)
      appendLog(`Connection open with ${connection.peer}.`)
    })

    connection.on('close', () => {
      connectionOpenedAtRef.current = null
      pendingPingRef.current.clear()
      setConnectionOpen(false)
      setConnectionTarget('')
      setIsSending(false)
      setLastPingMs(null)
      setAvgPingMs(null)
      setPingCount(0)
      setUptimeTick(0)
      appendLog('Connection closed.')
    })

    connection.on('error', (error) => {
      appendLog(`Connection error: ${error.message}`)
    })

    connection.on('data', (payload) => {
      if (typeof payload === 'string') {
        handleIncomingControlMessage(payload)
        return
      }

      void handleIncomingBinary(payload)
    })
  }

  const createOrResetPeer = (): void => {
    const normalizedLocalId = normalizePeerId(localPeerId)
    setLocalPeerId(normalizedLocalId)

    if (!isValidPeerId(normalizedLocalId)) {
      appendLog('Local peer ID must be exactly 9 alphanumeric characters.')
      return
    }

    clearConnection()
    resetReceiveState()
    clearIncomingFile()

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    setPeerOnline(false)

    const peer = new Peer(normalizedLocalId)
    peerRef.current = peer

    peer.on('open', (id) => {
      setLocalPeerId(id)
      setPeerOnline(true)
      appendLog(`Peer is online as ${id}.`)
    })

    peer.on('connection', (incomingConnection) => {
      appendLog(`Incoming connection from ${incomingConnection.peer}.`)
      bindConnection(incomingConnection)
    })

    peer.on('error', (error) => {
      appendLog(`Peer error: ${error.message}`)
    })

    peer.on('disconnected', () => {
      setPeerOnline(false)
      appendLog('Peer disconnected from signaling. Restart if needed.')
    })

    peer.on('close', () => {
      setPeerOnline(false)
      appendLog('Peer closed.')
    })
  }

  const connectToRemotePeer = (): void => {
    const remoteId = normalizePeerId(remotePeerIdInput)
    setRemotePeerIdInput(remoteId)

    if (!isValidPeerId(remoteId)) {
      appendLog('Remote peer ID must be exactly 9 alphanumeric characters.')
      return
    }

    const peer = peerRef.current
    if (!peer || peer.destroyed) {
      appendLog('Start your local peer first.')
      return
    }

    if (remoteId === localPeerId) {
      appendLog('Remote peer ID must be different from your local ID.')
      return
    }

    appendLog(`Connecting to ${remoteId}...`)
    const connection = peer.connect(remoteId, { reliable: true })
    bindConnection(connection)
  }

  const sendFile = async (): Promise<void> => {
    const connection = connectionRef.current
    if (!connection || !connection.open) {
      appendLog('No active connection. Connect to another peer first.')
      return
    }

    if (!selectedFile) {
      appendLog('Choose a file before sending.')
      return
    }

    setIsSending(true)
    setSendProgress(0)

    try {
      const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE)
      const metadata: TransferMeta = {
        type: 'meta',
        fileName: selectedFile.name,
        mimeType: selectedFile.type || 'application/octet-stream',
        size: selectedFile.size,
        totalChunks,
      }

      connection.send(JSON.stringify(metadata))
      appendLog(
        `Sending ${selectedFile.name} in ${totalChunks} chunk${totalChunks === 1 ? '' : 's'}.`,
      )

      const fileBuffer = await selectedFile.arrayBuffer()

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const start = chunkIndex * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, fileBuffer.byteLength)
        const chunk = fileBuffer.slice(start, end)

        connection.send(chunk)
        setSentBytes((previous) => previous + chunk.byteLength)

        setSendProgress(((chunkIndex + 1) / totalChunks) * 100)

        if (chunkIndex % 16 === 0) {
          await sleep(0)
        }
      }

      const done: TransferDone = { type: 'done' }
      connection.send(JSON.stringify(done))
      appendLog(`Finished sending ${selectedFile.name}.`)
      setSendProgress(100)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      appendLog(`Send failed: ${message}`)
    } finally {
      setIsSending(false)
    }
  }

  const resetAll = (): void => {
    clearConnection()
    resetReceiveState()
    clearIncomingFile()
    setSelectedFile(null)
    setSentBytes(0)
    setSendProgress(0)
    setReceiveProgress(0)
    setRemotePeerIdInput('')
    setActivityLog([])

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    setPeerOnline(false)
    setConnectionOpen(false)
    setConnectionTarget('')
    setLocalPeerId(randomPeerId())
  }

  useEffect(() => {
    if (!connectionOpen) {
      return
    }

    const pendingPingMap = pendingPingRef.current

    const probe = (): void => {
      const connection = connectionRef.current
      if (!connection?.open) {
        return
      }

      const probeId = Date.now()
      pendingPingMap.set(probeId, performance.now())
      const pingMessage: PingMessage = { type: 'ping', probeId }
      connection.send(JSON.stringify(pingMessage))
    }

    const pingTimer = window.setInterval(probe, 5000)
    const uptimeTimer = window.setInterval(() => {
      setUptimeTick((previous) => previous + 1)
    }, 1000)

    probe()

    return () => {
      window.clearInterval(pingTimer)
      window.clearInterval(uptimeTimer)
      pendingPingMap.clear()
    }
  }, [connectionOpen])

  useEffect(() => {
    return () => {
      if (peerRef.current) {
        peerRef.current.destroy()
      }
      if (receivedFile) {
        URL.revokeObjectURL(receivedFile.url)
      }
    }
  }, [receivedFile])

  const uptimeSeconds = connectionOpenedAtRef.current
    ? Math.max(0, Math.floor((Date.now() - connectionOpenedAtRef.current) / 1000))
    : 0

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">WebRTC Diagnostic Utility</p>
        <h1>PeerJS Datachannel Test Bench</h1>
        <p>
          Validate peer connectivity between two browsers.
          This tool is designed for lab checks, QA workflows, and controlled network tests.
        </p>
      </header>

      <section className="card">
        <h2>1. Bring Your Peer Online</h2>
        <div className="inline-grid">
          <label htmlFor="local-id">Your 9-character ID</label>
          <input
            id="local-id"
            value={localPeerId}
            maxLength={ID_LENGTH}
            onChange={(event) => {
              setLocalPeerId(normalizePeerId(event.target.value))
            }}
            placeholder="A1B2C3D4E"
          />
          <button type="button" onClick={createOrResetPeer}>
            Start Local Peer
          </button>
        </div>
        <p className="status">
          Local status: <strong>{peerOnline ? 'Online' : 'Offline'}</strong>
        </p>
      </section>

      <section className="card">
        <h2>2. Connect to Another Peer</h2>
        <div className="inline-grid">
          <label htmlFor="remote-id">Remote 9-character ID</label>
          <input
            id="remote-id"
            value={remotePeerIdInput}
            maxLength={ID_LENGTH}
            onChange={(event) => {
              setRemotePeerIdInput(normalizePeerId(event.target.value))
            }}
            placeholder="Z9Y8X7W6V"
          />
          <button type="button" onClick={connectToRemotePeer} disabled={!peerOnline}>
            Connect
          </button>
        </div>
        <p className="status">
          Connection: <strong>{connectionOpen ? `Connected to ${connectionTarget}` : 'Not connected'}</strong>
        </p>
      </section>

      <section className="card two-col">
        <div>
          <h2>3. Send Test Payload</h2>
          <label htmlFor="file-input">Select file</label>
          <input
            id="file-input"
            type="file"
            onChange={(event) => {
              const nextFile = event.target.files?.[0] ?? null
              setSelectedFile(nextFile)
            }}
          />
          <button
            type="button"
            onClick={() => {
              void sendFile()
            }}
            disabled={!connectionOpen || isSending || !selectedFile}
          >
            {isSending ? 'Sending...' : 'Send File'}
          </button>
          <progress value={sendProgress} max={100}></progress>
          <p className="metric">Upload progress: {sendProgress.toFixed(1)}%</p>
        </div>

        <div>
          <h2>4. Receive and Verify</h2>
          <p className="metric">
            Receive status: {isReceiving ? 'Receiving data...' : 'Awaiting payload'}
          </p>
          <progress value={receiveProgress} max={100}></progress>
          <p className="metric">Download progress: {receiveProgress.toFixed(1)}%</p>
          {receivedFile ? (
            <a className="download" href={receivedFile.url} download={receivedFile.name}>
              Download {receivedFile.name} ({(receivedFile.size / (1024 * 1024)).toFixed(2)} MB)
            </a>
          ) : (
            <p className="metric">No file received yet.</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Connection Diagnostics</h2>
        <div className="diagnostics-grid">
          <p>
            <span>Signaling:</span>
            <strong>{peerOnline ? 'Connected' : 'Disconnected'}</strong>
          </p>
          <p>
            <span>Datachannel:</span>
            <strong>{connectionOpen ? 'Open' : 'Closed'}</strong>
          </p>
          <p>
            <span>Remote peer:</span>
            <strong>{connectionTarget || 'None'}</strong>
          </p>
          <p>
            <span>Session uptime:</span>
            <strong>{uptimeSeconds}s</strong>
          </p>
          <p>
            <span>Last RTT:</span>
            <strong>{lastPingMs === null ? 'n/a' : `${lastPingMs.toFixed(1)} ms`}</strong>
          </p>
          <p>
            <span>Average RTT:</span>
            <strong>{avgPingMs === null ? 'n/a' : `${avgPingMs.toFixed(1)} ms`}</strong>
          </p>
          <p>
            <span>Probe count:</span>
            <strong>{pingCount}</strong>
          </p>
          <p>
            <span>Bytes sent:</span>
            <strong>{formatBytes(sentBytes)}</strong>
          </p>
          <p>
            <span>Bytes received:</span>
            <strong>{formatBytes(receivedBytes)}</strong>
          </p>
        </div>
      </section>

      <section className="card">
        <div className="actions">
          <h2>Activity Log</h2>
          <button type="button" className="secondary" onClick={resetAll}>
            Reset Session
          </button>
        </div>
        <ul className="log-list">
          {activityLog.length > 0 ? (
            activityLog.map((entry) => <li key={entry}>{entry}</li>)
          ) : (
            <li>No events yet. Start a local peer to begin.</li>
          )}
        </ul>
      </section>
    </main>
  )
}

export default App
