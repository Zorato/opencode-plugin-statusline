/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

// Width of the context bar in cells, matching the Claude Code status line.
const BAR_WIDTH = 16
// Anthropic prompt cache entries live 5 minutes by default. OpenCode sends no
// explicit TTL, so the warm window starts at the end of the last step.
const DEFAULT_CACHE_TTL_MINUTES = 5
// Under this much cache time left the next request may re-write the whole
// prefix, so the timer turns into a warning.
const CACHE_WARNING_MS = 60_000

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

type Data = Plugin.Context["data"]
type Message = ReturnType<Data["session"]["message"]["list"]>[number]
type Model = NonNullable<ReturnType<Data["location"]["model"]["list"]>>[number]
type Assistant = Extract<Message, { type: "assistant" }>
type AssistantUsage = Assistant & { tokens: NonNullable<Assistant["tokens"]> }
type Tone = "muted" | "base" | "success" | "warning" | "error"
type Chunk = { readonly text: string; readonly tone: Tone }
type Segment = ReadonlyArray<Chunk>

// The assistant step whose tokens fill the context window now: the latest one
// after the last completed compaction and before the revert boundary. The host
// TUI, the desktop app and this line must agree on that step.
function latestUsage(messages: ReadonlyArray<Message>, boundary?: string): AssistantUsage | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is AssistantUsage =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

function totalTokens(tokens: AssistantUsage["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Thousands, like the status line this plugin copies: 100k, 363k, 1000k.
export function compact(value: number): string {
  if (value < 1000) return String(value)
  return `${Math.round(value / 1000)}k`
}

// Floor, not round: 10% of 16 cells fills one cell.
export function bar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.floor((clamped * BAR_WIDTH) / 100)
  return "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled)
}

export function duration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`
}

export function money(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01"
  return MONEY.format(value)
}

export function contextSegment(
  messages: ReadonlyArray<Message>,
  models: ReadonlyArray<Model> | undefined,
  boundary?: string,
) {
  const last = latestUsage(messages, boundary)
  if (!last) return
  const tokens = totalTokens(last.tokens)
  if (tokens <= 0) return
  const model = models?.find((item) => item.providerID === last.model.providerID && item.id === last.model.id)
  const limit = model?.limit.context
  if (!limit) return { text: `${compact(tokens)} tokens`, percent: undefined, percentText: "" }
  const percent = Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)))
  return {
    text: `[${bar(percent)}] ${compact(tokens)}/${compact(limit)} `,
    percent,
    percentText: `(${percent}%)`,
  }
}

// The share of prompt tokens the provider served from its cache, and how long
// the entry survives after the last step. A later request reads a cold cache
// and pays full price for the whole prefix.
export function cacheSegment(
  messages: ReadonlyArray<Message>,
  boundary: string | undefined,
  ttlMs: number,
  now: number,
) {
  const last = latestUsage(messages, boundary)
  if (!last) return
  const read = last.tokens.cache.read
  const write = last.tokens.cache.write
  const prompt = read + write + last.tokens.input
  if (prompt <= 0) return
  if (read === 0 && write === 0) return { hit: "--", rest: "", remaining: undefined }
  const hit = `${Math.round((read / prompt) * 100)}%`
  const expires = (last.time.completed ?? last.time.created) + ttlMs
  const remaining = expires - now
  if (remaining <= 0) return { hit, rest: " cold", remaining }
  return { hit, rest: ` warm ${duration(remaining)}`, remaining }
}

export function contextTone(percent: number | undefined): Tone {
  if (percent === undefined) return "muted"
  if (percent <= 25) return "success"
  if (percent <= 50) return "warning"
  return "error"
}

export function cacheTone(remaining: number | undefined): Tone {
  if (remaining === undefined) return "muted"
  if (remaining <= 0) return "error"
  return remaining < CACHE_WARNING_MS ? "warning" : "success"
}

// What runs right now beside the session: live subagents and shell commands.
// The built-in prompt footer showed the same counters; it is disabled in
// favour of this line, so the counters live here.
export function activitySegment(
  data: Data,
  sessionID: string,
  location: Plugin.Context["location"],
): string | undefined {
  const subagents = data.session
    .family(sessionID)
    .filter((id) => id !== sessionID && data.session.status(id) === "running").length
  const shells = data.shell.list(location).filter((shell) => shell.metadata.sessionID === sessionID).length
  const parts = [
    subagents > 0 ? `${subagents} subagent${subagents === 1 ? "" : "s"}` : undefined,
    shells > 0 ? `${shells} shell${shells === 1 ? "" : "s"}` : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

function StatusLine(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const options = props.context.options
  const ttlMs =
    (typeof options.cacheTtlMinutes === "number" ? options.cacheTtlMinutes : DEFAULT_CACHE_TTL_MINUTES) * 60_000
  const showCost = options.showCost !== false

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 15_000)
  onCleanup(() => clearInterval(timer))

  const messages = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const boundary = createMemo(() => session()?.revert?.messageID)
  const models = createMemo(() => props.context.data.location.model.list(session()?.location))
  // The host sums the family cost for a root session, so subagent spend is
  // already included and a subagent's own cost stays local to it.
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const tone = (value: Tone) =>
    value === "muted" ? theme.text.muted : value === "base" ? theme.text.base : theme.text.feedback[value].base

  // One entry per segment; a segment may mix tones, e.g. a muted label and a
  // colored value. An empty list renders nothing at all.
  const view = createMemo(() => {
    const segments: Segment[] = []
    const activity = activitySegment(props.context.data, props.sessionID, props.context.location)
    if (activity) segments.push([{ text: activity, tone: "base" }])

    const context = contextSegment(messages(), models(), boundary())
    if (context) {
      segments.push([
        { text: "Context: ", tone: "muted" },
        { text: context.text, tone: "base" },
        { text: context.percentText, tone: contextTone(context.percent) },
      ])
    }

    const cache = cacheSegment(messages(), boundary(), ttlMs, now())
    if (cache) {
      segments.push([
        { text: "Cache: ", tone: "muted" },
        { text: cache.hit, tone: "base" },
        { text: cache.rest, tone: cacheTone(cache.remaining) },
      ])
    }

    const spent = cost()
    if (showCost && spent > 0) segments.push([{ text: money(spent), tone: "base" }])
    return segments
  })

  return (
    <text wrapMode="none" truncate flexShrink={1} minWidth={0}>
      <For each={view()}>
        {(segment, index) => (
          <>
            <span style={{ fg: theme.text.muted }}>{index() === 0 ? "  " : "  |  "}</span>
            <For each={segment}>{(chunk) => <span style={{ fg: tone(chunk.tone) }}>{chunk.text}</span>}</For>
          </>
        )}
      </For>
    </text>
  )
}

export default Plugin.define({
  id: "statusline",
  setup(context) {
    return context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.mode === "normal" ? input.sessionID : undefined} fallback={<text />}>
          {(sessionID) => <StatusLine context={context} sessionID={sessionID()} />}
        </Show>
      ),
    })
  },
})
