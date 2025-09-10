import React, { useMemo, useState } from 'react'
import { newHttpBatchRpcSession } from '@cloudflare/jsrpc'

type Result = {
  posts: number
  ms: number
  user: any
  profile: any
  notifications: any
}

export function App() {
  const [pipelined, setPipelined] = useState<Result | null>(null)
  const [sequential, setSequential] = useState<Result | null>(null)
  const [running, setRunning] = useState(false)

  // Simulated per-direction network RTT to make the advantage obvious
  const SIMULATED_RTT_MS = 120
  const SIMULATED_RTT_JITTER_MS = 40
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const jittered = () => SIMULATED_RTT_MS + (SIMULATED_RTT_JITTER_MS ? Math.random() * SIMULATED_RTT_JITTER_MS : 0)

  // Count RPC POSTs by wrapping fetch while this component is mounted.
  const wrapFetch = useMemo(() => {
    let posts = 0
    const orig = globalThis.fetch
    function install() {
      ;(globalThis as any).fetch = async (input: RequestInfo, init?: RequestInit) => {
        const method = (init?.method) || (input instanceof Request ? input.method : 'GET')
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/api') && method === 'POST') {
          posts++
          await sleep(jittered())
          const resp = await orig(input as any, init)
          await sleep(jittered())
          return resp
        }
        return orig(input as any, init)
      }
    }
    function uninstall() { ;(globalThis as any).fetch = orig }
    function get() { return posts }
    function reset() { posts = 0 }
    return { install, uninstall, get, reset }
  }, [])

  async function runPipelined() {
    wrapFetch.reset()
    const t0 = performance.now()
    const api = newHttpBatchRpcSession('/api')
    const user = api.authenticate('cookie-123')
    const profile = api.getUserProfile(user.id)
    const notifications = api.getNotifications(user.id)
    const [u, p, n] = await Promise.all([user, profile, notifications])
    const t1 = performance.now()
    return { posts: wrapFetch.get(), ms: t1 - t0, user: u, profile: p, notifications: n }
  }

  async function runSequential() {
    wrapFetch.reset()
    const t0 = performance.now()
    const api1 = newHttpBatchRpcSession('/api')
    const u = await api1.authenticate('cookie-123')

    const api2 = newHttpBatchRpcSession('/api')
    const p = await api2.getUserProfile(u.id)

    const api3 = newHttpBatchRpcSession('/api')
    const n = await api3.getNotifications(u.id)

    const t1 = performance.now()
    return { posts: wrapFetch.get(), ms: t1 - t0, user: u, profile: p, notifications: n }
  }

  async function runDemo() {
    if (running) return
    setRunning(true)
    wrapFetch.install()
    try {
      const piped = await runPipelined()
      setPipelined(piped)
      const seq = await runSequential()
      setSequential(seq)
    } finally {
      wrapFetch.uninstall()
      setRunning(false)
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.5 }}>
      <h1>JSRPC: Workers + React</h1>
      <div style={{ opacity: 0.8 }}>
        Simulated network RTT (each direction): ~{SIMULATED_RTT_MS}ms ±{SIMULATED_RTT_JITTER_MS}ms
      </div>
      <p>This demo calls the Worker API in two ways:</p>
      <ul>
        <li><b>Pipelined batch</b>: dependent calls in one round trip</li>
        <li><b>Sequential non-batched</b>: three separate round trips</li>
      </ul>
      <button onClick={runDemo} disabled={running}>
        {running ? 'Running…' : 'Run demo'}
      </button>

      {pipelined && (
        <section style={{ marginTop: 24 }}>
          <h2>Pipelined (batched)</h2>
          <div>HTTP POSTs: {pipelined.posts}</div>
          <div>Time: {pipelined.ms.toFixed(1)} ms</div>
          <pre>{JSON.stringify({
            user: pipelined.user,
            profile: pipelined.profile,
            notifications: pipelined.notifications,
          }, null, 2)}</pre>
        </section>
      )}

      {sequential && (
        <section style={{ marginTop: 24 }}>
          <h2>Sequential (non-batched)</h2>
          <div>HTTP POSTs: {sequential.posts}</div>
          <div>Time: {sequential.ms.toFixed(1)} ms</div>
          <pre>{JSON.stringify({
            user: sequential.user,
            profile: sequential.profile,
            notifications: sequential.notifications,
          }, null, 2)}</pre>
        </section>
      )}

      {(pipelined && sequential) && (
        <section style={{ marginTop: 24 }}>
          <h2>Summary</h2>
          <div>Pipelined: {pipelined.posts} POST, {pipelined.ms.toFixed(1)} ms</div>
          <div>Sequential: {sequential.posts} POSTs, {sequential.ms.toFixed(1)} ms</div>
        </section>
      )}
    </div>
  )
}
