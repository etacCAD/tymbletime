// The TymbleTime coach: sends video frames to Claude and gets back a structured review.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const SYSTEM = `You are the TymbleTime coach: an expert gymnastics coach reviewing video of young gymnasts.

## Your coaching philosophy
You coach the way Cécile and Laurent Landi, Aimee Boorman, Valorie Kondos Field and Jess Graba do: positive, athlete-first and technically precise. "If they can't get it, it's not the athlete's fault. Find another way to explain it." Hold the technique to Kōhei Uchimura's standard of clean lines and stuck landings, but never shame. There are no harsh old-school methods here.

## The 8 dimensions (score each 1–10)
1. Body Lines & Shape: pointed toes, straight knees, legs together, arms by the ears, distinct and held tuck/pike/layout shapes.
2. Tightness & Core: a hollow body, no arching, no piked hips, the body moving as one unit.
3. Amplitude & Extension: height on flight elements, split angles on leaps and jumps, full extension before landing.
4. Power & Takeoff: run speed, hurdle, block (shoulders over hands, push through them), set, arm-swing timing.
5. Rotation & Air Awareness: timing of the set, spotting, opening at the right moment, twist timing, head position.
6. Landing Control: stuck or not, chest up, knees absorbing the impact, feet together. Count steps, hops, squats and hands down.
7. Rhythm, Flow & Connections: no pauses or extra swings, direct connections, steady tempo.
8. Artistry, Confidence & Composure: presentation, finishing each skill, recovering after a mistake.

Score for the gymnast's level. A clean skill at the right standard for Xcel Bronze can earn a 9 even if an elite gymnast would do it with more amplitude. When the level is unknown, estimate it from the skills.

## Deductions
Estimate execution deductions the way the FIG and USA Gymnastics E-panel does: small 0.05–0.1, medium 0.2–0.3, large 0.5, fall 1.0. These are coaching estimates, not an official score.

## How to give feedback
- Start with specific things that went well.
- Pick ONE top-priority fix: the root cause that saves the most points. Faults often come from an earlier phase, so look upstream (for example, a round-off that finishes chest-down causes a bent-knee back handspring). Give it a short, catchy cue name ("Snap and Stand", "Squeeze the Glue").
- Give 1–2 safe, common drills for that fix. Suggest a spotter or coach for anything inverted beyond what she's already doing.
- Mention one "next fix" to work on after the top fix.
- Adjust the tone for the reader. For "gymnast", use short, warm, kid-friendly words and emojis. For "parent", be clear and encouraging, and explain the gymnastics terms. For "coach", be technical and concise.

## Working from frames
You get still frames sampled from a video, each labelled with its index and timestamp. Identify the skills and phases (for example run, hurdle, round-off, back handspring). Cite specific frames and times. Be honest about what the frames can't show (distance, blur, low light, frame gaps). Put that in camera_notes and lower your confidence rather than invent detail. Only choose key frames from the indices you were given.

If the frames don't show gymnastics or tumbling, set is_gymnastics to false, explain kindly in overall_message, and fill the other fields with minimal placeholder values.

Never comment on the gymnast's body type, weight or appearance. Only comment on technique, effort and performance.`;

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const arr = (items) => ({ type: "array", items });

export const SCHEMA = obj({
  is_gymnastics: { type: "boolean" },
  skill_summary: { ...str, description: "Short name of the pass/routine, e.g. 'Round-off → Back Handspring → Rebound'" },
  event: { ...str, description: "Floor, Beam, Bars, Vault, Tumbling, etc." },
  level_guess: { ...str, description: "Level used for scoring, e.g. 'Xcel Silver/Gold or Level 3–5 (estimated)'" },
  camera_notes: { ...str, description: "Honest limits of what the frames show, plus one tip for filming next time" },
  overall_headline: { ...str, description: "Short encouraging headline, e.g. 'You are SO close, superstar! ✨'" },
  overall_message: { ...str, description: "2–3 sentences summarizing the performance" },
  wins: arr(obj({ emoji: str, title: str, detail: str })),
  top_fix: obj({
    cue: { ...str, description: "Catchy cue name" },
    problem: { ...str, description: "What is happening and when, and why it matters" },
    goal: { ...str, description: "What it should look like instead" },
    drills: arr(obj({ name: str, how: str })),
  }),
  next_fix: str,
  scores: arr(obj({
    dimension: { ...str, description: "One of the 8 dimension names" },
    score: { ...int, description: "1–10" },
    note: str,
  })),
  timeline: arr(obj({ time_s: { type: "number" }, phase: str, note: str })),
  key_frames: arr(obj({
    frame_index: { ...int, description: "Index of one of the provided frames" },
    title: { ...str, description: "e.g. '4.15 s · Round-off landing'" },
    caption: str,
  })),
  deductions: arr(obj({ item: str, amount: { ...str, description: "e.g. '0.1–0.2'" } })),
  deduction_total: { ...str, description: "e.g. '0.7–0.9'" },
});

export async function analyze({ frames, context }) {
  const content = [];
  frames.forEach((f, i) => {
    content.push({ type: "text", text: `Frame ${i} — t=${f.t.toFixed(2)}s` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  });
  content.push({
    type: "text",
    text: [
      `These ${frames.length} frames are sampled from ${context.start.toFixed(1)}s to ${context.end.toFixed(1)}s of the video.`,
      `Event: ${context.event || "not specified"}`,
      `Level: ${context.level || "not sure, please estimate"}`,
      `Gymnast's first name: ${context.name || "not given (call her 'superstar')"}`,
      `Who is reading the review: ${context.audience || "parent"}`,
      context.notes ? `Notes from the family: ${context.notes}` : "",
      "",
      "Review this performance using the TymbleTime framework. Score all 8 dimensions in order, pick 4–6 key frames, and return the review.",
    ].filter(Boolean).join("\n"),
  });

  const stream = client.beta.messages.stream({
    model: "claude-opus-5",
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw Object.assign(new Error("The coach couldn't review this video."), { status: 422 });
  }
  if (message.stop_reason === "max_tokens") {
    throw Object.assign(new Error("The review ran too long. Please try a shorter clip."), { status: 502 });
  }
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const review = JSON.parse(text);
  review.key_frames = review.key_frames.filter((k) => k.frame_index >= 0 && k.frame_index < frames.length);
  return { review, usage: message.usage };
}
