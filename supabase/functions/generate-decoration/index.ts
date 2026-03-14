import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_API = "https://api.replicate.com/v1";

// ── LLM Prompt Optimization ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a prompt engineer specializing in image-to-image editing for wedding venue decoration.
Given a user instruction in any language, produce a concise, English prompt optimized for Stable Diffusion (instruct-pix2pix).
Rules:
- Output ONLY the optimized prompt text, nothing else.
- Keep the same camera angle, perspective and background.
- Be specific about colors, materials, sizes and placement.
- Always end with: "Photorealistic, high quality, maintain original perspective."`;

async function optimizeWithOpenAI(instruction: string): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY não configurada (necessária para OpenAI via gateway).");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-5-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI (gateway) error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || instruction;
}

async function optimizeWithClaude(instruction: string): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY não configurada. Adicione nas configurações do projeto.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: instruction }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || instruction;
}

async function optimizeWithGemini(instruction: string): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY não configurada (necessária para Gemini via gateway).");

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: instruction },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini (gateway) error ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || instruction;
}

type LlmProvider = "openai" | "claude" | "gemini";

async function optimizePrompt(instruction: string, provider: LlmProvider): Promise<string> {
  console.log(`Optimizing prompt with ${provider}...`);
  switch (provider) {
    case "openai":
      return optimizeWithOpenAI(instruction);
    case "claude":
      return optimizeWithClaude(instruction);
    case "gemini":
      return optimizeWithGemini(instruction);
    default:
      return optimizeWithOpenAI(instruction);
  }
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
    const rawToken = Deno.env.get("REPLICATE_API_TOKEN");
    console.log(`[DEBUG] REPLICATE_API_TOKEN raw length: ${rawToken?.length ?? 'undefined'}, first 8 chars: ${rawToken?.substring(0, 8) ?? 'N/A'}`);
    const REPLICATE_API_TOKEN = normalizeReplicateToken(rawToken);
    console.log(`[DEBUG] REPLICATE_API_TOKEN normalized length: ${REPLICATE_API_TOKEN.length}, first 8 chars: ${REPLICATE_API_TOKEN.substring(0, 8)}`);
    if (!REPLICATE_API_TOKEN) {
      throw new Error("REPLICATE_API_TOKEN não está configurado ou está vazio.");
    }

    const { image, prompt, llm_provider = "openai" } = await req.json();

    if (!image) throw new Error("Imagem é obrigatória.");
    if (!prompt) throw new Error("Prompt é obrigatório.");

    // Step 1: Use the selected LLM to optimize the user instruction into a Stable Diffusion prompt
    let optimizedPrompt: string;
    try {
      optimizedPrompt = await optimizePrompt(prompt, llm_provider as LlmProvider);
      console.log(`Optimized prompt (${llm_provider}):`, optimizedPrompt);
    } catch (llmError) {
      console.error(`LLM optimization failed (${llm_provider}):`, llmError);
      // Fallback: use the raw instruction with basic English wrapping
      optimizedPrompt = `Wedding venue decoration edit: ${prompt}. Maintain the exact same camera angle, perspective, and background. Photorealistic result.`;
      console.log("Using fallback prompt:", optimizedPrompt);
    }

    // Step 2: Send to Replicate for image generation
    console.log("Creating Replicate prediction with instruct-pix2pix...");

    const createRes = await fetch(`${REPLICATE_API}/models/timothybrooks/instruct-pix2pix/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          image,
          prompt: optimizedPrompt,
          num_inference_steps: 50,
          image_guidance_scale: 1.5,
          guidance_scale: 7.5,
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("Replicate create error:", createRes.status, errText);

      if (createRes.status === 401 || createRes.status === 403) {
        return new Response(
          JSON.stringify({ error: "Token da API Replicate inválido ou sem permissão." }),
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
          JSON.stringify({ error: "Limite de requisições excedido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Replicate API error: ${createRes.status} - ${errText}`);
    }

    const prediction = await createRes.json();
    console.log("Prediction created:", prediction.id);

    const result = await pollPrediction(prediction.id, REPLICATE_API_TOKEN);
    console.log("Prediction completed:", result.id);

    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;

    if (!outputUrl) {
      throw new Error("Nenhuma imagem foi gerada pelo modelo.");
    }

    return new Response(
      JSON.stringify({ imageUrl: outputUrl, optimizedPrompt, llmUsed: llm_provider }),
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
