import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";

// ── LLM: Scene Description Update ──────────────────────────────────────────

const SCENE_UPDATE_SYSTEM = `You are a scene description manager for a wedding venue decoration editor.
Your job is to maintain a consolidated description of the current scene state.

You will receive:
1. The current scene description (may be empty for initial setup)
2. A new user instruction

Rules:
- If no current description exists, create one describing the venue based on the instruction.
- If a current description exists, MERGE the new instruction into it.
- The result must be a SINGLE consolidated description of the FULL current scene.
- Include ALL previously added decorations that weren't explicitly removed.
- Be specific about colors, materials, sizes, and placement.
- Write in English.
- Output ONLY the updated scene description, nothing else.

Examples:
Input: current="" instruction="igreja com corredor central e bancos de madeira"
Output: "A wedding church with a central aisle, wooden pews on both sides, and an altar at the far end."

Input: current="A wedding church with a central aisle and wooden pews." instruction="adicione flores brancas ao longo do corredor"
Output: "A wedding church with a central aisle lined with arrangements of white flowers beside the wooden pews, and an altar at the far end."

Input: current="A wedding church with white flowers along the aisle." instruction="dobre o tamanho das flores"  
Output: "A wedding church with a central aisle lined with large, prominent arrangements of white flowers beside the wooden pews, and an altar at the far end."`;

const PROMPT_SYSTEM = `You are a prompt engineer for Stable Diffusion (instruct-pix2pix) image-to-image editing.
Given a consolidated scene description, produce a concise English prompt optimized for image editing.
Rules:
- Output ONLY the optimized prompt text, nothing else.
- Keep the same camera angle, perspective and background.
- Be specific about colors, materials, sizes and placement.
- Always end with: "Photorealistic, high quality, maintain original perspective and camera angle."`;

async function callLLM(systemPrompt: string, userMessage: string, provider: string): Promise<string> {
  if (provider === "claude") {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new Error("ANTHROPIC_API_KEY não configurada.");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || userMessage;
  }

  // OpenAI and Gemini both go through Lovable gateway
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY não configurada.");
  const model = provider === "gemini" ? "google/gemini-2.5-flash" : "openai/gpt-5-mini";

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || userMessage;
}

// ── Replicate polling ───────────────────────────────────────────────────────

async function pollPrediction(id: string, token: string, maxAttempts = 60): Promise<any> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${REPLICATE_API}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(data.error || "A geração da imagem falhou.");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout: a geração demorou demais.");
}

function normalizeReplicateToken(rawToken: string | undefined): string {
  if (!rawToken) return "";
  return rawToken.trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "");
}

// ── Main handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const REPLICATE_API_TOKEN = normalizeReplicateToken(Deno.env.get("REPLICATE_API_TOKEN"));
    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN não está configurado.");

    const {
      image,
      prompt,
      scene_description = "",
      llm_provider = "openai",
      force_text_to_image = false,
    } = await req.json();

    if (!image) throw new Error("Imagem é obrigatória.");
    if (!prompt) throw new Error("Prompt é obrigatório.");

    // Step 1: Update consolidated scene description
    let updatedSceneDescription: string;
    try {
      const sceneInput = scene_description
        ? `Current scene description: "${scene_description}"\n\nNew user instruction: "${prompt}"`
        : `User instruction (initial scene): "${prompt}"`;
      updatedSceneDescription = await callLLM(SCENE_UPDATE_SYSTEM, sceneInput, llm_provider);
      console.log("Updated scene description:", updatedSceneDescription);
    } catch (e) {
      console.error("Scene description update failed:", e);
      updatedSceneDescription = scene_description
        ? `${scene_description}. ${prompt}`
        : prompt;
    }

    // Step 2: Generate optimized prompt from consolidated description
    let optimizedPrompt: string;
    try {
      optimizedPrompt = await callLLM(PROMPT_SYSTEM, updatedSceneDescription, llm_provider);
      console.log("Optimized prompt:", optimizedPrompt);
    } catch (e) {
      console.error("Prompt optimization failed:", e);
      optimizedPrompt = `${updatedSceneDescription}. Photorealistic, high quality, maintain original perspective.`;
    }

    // Step 3: Send to Replicate (instruct-pix2pix) — always image-to-image
    console.log(`Creating Replicate prediction (force_t2i=${force_text_to_image})...`);

    const replicateInput: Record<string, unknown> = {
      image,
      prompt: optimizedPrompt,
      num_inference_steps: 25,
      image_guidance_scale: 1.2,
      guidance_scale: 7.5,
    };

    const createRes = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "30c1d0b916a6f8efce20493f5d61ee27491ab2a60437c13c588468b9810ec23f",
        input: replicateInput,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("Replicate create error:", createRes.status, errText);

      if (createRes.status === 401 || createRes.status === 403) {
        return new Response(
          JSON.stringify({ error: "Token da API Replicate inválido." }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (createRes.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos insuficientes na conta Replicate." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (createRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições excedido." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Replicate API error: ${createRes.status} - ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    const result = await pollPrediction(prediction.id, REPLICATE_API_TOKEN);
    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
    if (!outputUrl) throw new Error("Nenhuma imagem foi gerada pelo modelo.");

    return new Response(
      JSON.stringify({
        imageUrl: outputUrl,
        optimizedPrompt,
        updatedSceneDescription,
        llmUsed: llm_provider,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("generate-decoration error:", e);
    const message = e instanceof Error ? e.message : "Erro desconhecido";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
