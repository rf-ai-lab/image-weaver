export type LayerAnchor = "ground_center" | "center";

export interface NormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceCropBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

export interface ObjectLayer {
  id: string;
  label: string;
  instruction: string;
  imageData: string;
  sourceCrop: SourceCropBounds;
  bbox: NormalizedBBox;
  anchor: LayerAnchor;
  createdStep: number;
}

export interface ObjectTransform {
  scale?: number;
  translateX?: number;
  translateY?: number;
  centerX?: number;
  centerY?: number;
  anchor?: LayerAnchor;
}

export interface ParsedObjectCommand {
  action: "transform_object";
  targetObject: "last_added_object" | "label";
  targetLabel?: string;
  transform: ObjectTransform;
}

type PlacementOptions = {
  instruction: string;
  label: string;
  sourceCrop: SourceCropBounds;
  baseWidth: number;
  baseHeight: number;
  existingLayers: ObjectLayer[];
  anchor: LayerAnchor;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

async function loadImage(source: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    if (!source.startsWith("data:")) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Falha ao carregar imagem."));
    image.src = source;
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Falha ao converter imagem para Data URL."));
    reader.readAsDataURL(blob);
  });
}

export async function resolveImageToDataUrl(source: string): Promise<string> {
  if (!source) throw new Error("Imagem inválida.");
  if (source.startsWith("data:")) return source;

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Não foi possível baixar imagem remota (${response.status}).`);
  }

  const blob = await response.blob();
  return blobToDataUrl(blob);
}

export async function detectOpaqueBounds(imageSource: string): Promise<SourceCropBounds> {
  const imageDataUrl = await resolveImageToDataUrl(imageSource);
  const image = await loadImage(imageDataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível criar contexto de canvas.");

  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];
      if (alpha > 8) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
    };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    imageWidth: canvas.width,
    imageHeight: canvas.height,
  };
}

export type ReferenceIntent = "replace" | "add" | "transform";

export interface ParsedReferenceIntent {
  intent: ReferenceIntent;
  targetLabel?: string;
  matchedLayerIndex: number;
}

const REPLACE_KEYWORDS = [
  "troc", "substitu", "replace", "swap", "no lugar",
  "em vez", "ao inves", "ao invés",
  "usar esse", "usar este", "usar essa", "usar esta",
  "usar como", "colocar esse", "colocar este",
];

export function parseReferenceIntent(
  instruction: string,
  existingLayers: ObjectLayer[]
): ParsedReferenceIntent {
  const normalized = normalizeText(instruction);

  const hasReplaceKeyword = REPLACE_KEYWORDS.some((kw) => normalized.includes(kw));

  const TRANSFORM_KEYWORDS = [
    "reduz", "diminu", "encolh", "aument", "maior", "menor",
    "mova", "move", "desloc", "suba", "abaix", "centraliz",
    "reposicion", "aproxim", "afast", "gir", "rot",
    "metade", "dobr", "ampli",
  ];
  const hasTransformKeyword = TRANSFORM_KEYWORDS.some((kw) => normalized.includes(kw));

  const inferredLabel = inferObjectLabel(instruction, 0);

  const matchedIndex = [...existingLayers]
    .map((layer, index) => ({ layer, index }))
    .reverse()
    .find(({ layer }) => {
      const layerLabel = normalizeText(layer.label);
      return layerLabel === normalizeText(inferredLabel) ||
        layerLabel.includes(normalizeText(inferredLabel)) ||
        normalizeText(inferredLabel).includes(layerLabel);
    })?.index ?? -1;

  if (hasReplaceKeyword) {
    return {
      intent: "replace",
      targetLabel: inferredLabel !== `objeto_0` ? inferredLabel : undefined,
      matchedLayerIndex: matchedIndex,
    };
  }

  // Transform intent: resize/move/reposition commands targeting an existing layer
  if (hasTransformKeyword && matchedIndex >= 0) {
    return {
      intent: "transform",
      targetLabel: inferredLabel,
      matchedLayerIndex: matchedIndex,
    };
  }

  if (matchedIndex >= 0) {
    const hasAddKeyword = /(adicion|acrescen|coloque mais|insira mais|novo|nova|mais um|mais uma)/.test(normalized);
    if (!hasAddKeyword) {
      return {
        intent: "replace",
        targetLabel: inferredLabel,
        matchedLayerIndex: matchedIndex,
      };
    }
  }

  return {
    intent: "add",
    targetLabel: inferredLabel !== `objeto_0` ? inferredLabel : undefined,
    matchedLayerIndex: -1,
  };
}

export function inferObjectLabel(instruction: string, fallbackIndex: number): string {
  const normalized = normalizeText(instruction);

  const keywordMap: { keywords: string[]; label: string }[] = [
    { keywords: ["portal", "arco"], label: "portal" },
    { keywords: ["flor", "flores", "arranjo", "arranjos", "bouquet"], label: "flores" },
    { keywords: ["palco", "altar"], label: "palco" },
    { keywords: ["iluminacao", "luz", "lustre", "lampada"], label: "iluminacao" },
    { keywords: ["mesa", "mesa posta"], label: "mesa" },
    { keywords: ["cadeira", "banco"], label: "cadeira" },
    { keywords: ["cortina", "tecido", "drapeado"], label: "cortina" },
  ];

  const match = keywordMap.find((entry) => entry.keywords.some((keyword) => normalized.includes(keyword)));
  if (match) return match.label;

  return `objeto_${fallbackIndex}`;
}

function inferAnchor(label: string, instruction: string): LayerAnchor {
  const normalizedLabel = normalizeText(label);
  const normalizedInstruction = normalizeText(instruction);

  if (["portal", "palco", "mesa", "cadeira"].includes(normalizedLabel)) {
    return "ground_center";
  }

  if (normalizedInstruction.includes("chao") || normalizedInstruction.includes("corredor")) {
    return "ground_center";
  }

  return "center";
}

function estimateInitialPlacement({
  instruction,
  label,
  sourceCrop,
  baseWidth,
  baseHeight,
  existingLayers,
  anchor,
}: PlacementOptions): NormalizedBBox {
  const normalizedInstruction = normalizeText(instruction);
  const normalizedLabel = normalizeText(label);

  const widthHints: Record<string, number> = {
    portal: 0.34,
    palco: 0.42,
    flores: 0.16,
    iluminacao: 0.2,
    mesa: 0.24,
    cadeira: 0.14,
    cortina: 0.3,
  };

  let targetWidthRatio = widthHints[normalizedLabel] ?? 0.2;

  if (normalizedInstruction.includes("grande") || normalizedInstruction.includes("maior")) {
    targetWidthRatio *= 1.2;
  }
  if (normalizedInstruction.includes("pequen") || normalizedInstruction.includes("menor")) {
    targetWidthRatio *= 0.85;
  }

  let centerX = 0.5;
  if (normalizedInstruction.includes("esquerda")) centerX = 0.28;
  if (normalizedInstruction.includes("direita")) centerX = 0.72;
  if (normalizedInstruction.includes("canto esquerdo")) centerX = 0.18;
  if (normalizedInstruction.includes("canto direito")) centerX = 0.82;

  let bottomY = 0.9;
  if (normalizedInstruction.includes("altar")) bottomY = 0.72;
  if (normalizedInstruction.includes("corredor")) bottomY = 0.92;
  if (normalizedInstruction.includes("fundo") || normalizedInstruction.includes("tras")) {
    bottomY = 0.78;
    targetWidthRatio *= 0.85;
  }
  if (normalizedInstruction.includes("topo") || normalizedInstruction.includes("teto")) {
    bottomY = 0.35;
  }

  const sameLabelCount = existingLayers.filter((layer) => normalizeText(layer.label) === normalizedLabel).length;
  if (sameLabelCount > 0) {
    const direction = sameLabelCount % 2 === 0 ? -1 : 1;
    const offsetLevel = Math.ceil(sameLabelCount / 2);
    centerX += direction * 0.1 * offsetLevel;
  }

  centerX = clamp(centerX, 0.08, 0.92);

  const objectAspect = sourceCrop.width / sourceCrop.height;
  let widthPx = clamp(baseWidth * targetWidthRatio, baseWidth * 0.05, baseWidth * 0.9);
  let heightPx = widthPx / objectAspect;

  if (heightPx > baseHeight * 0.9) {
    heightPx = baseHeight * 0.9;
    widthPx = heightPx * objectAspect;
  }

  const width = widthPx / baseWidth;
  const height = heightPx / baseHeight;

  let x = centerX - width / 2;
  let y = anchor === "ground_center" ? bottomY - height : 0.5 - height / 2;

  x = clamp(x, 0, 1 - width);
  y = clamp(y, 0, 1 - height);

  return { x, y, width, height };
}

export async function createObjectLayerFromSegmented(params: {
  segmentedImage: string;
  instruction: string;
  step: number;
  existingLayers: ObjectLayer[];
  baseImage: string;
}): Promise<ObjectLayer> {
  const imageData = await resolveImageToDataUrl(params.segmentedImage);
  const sourceCrop = await detectOpaqueBounds(imageData);
  const baseData = await resolveImageToDataUrl(params.baseImage);
  const base = await loadImage(baseData);

  const label = inferObjectLabel(params.instruction, params.step);
  const anchor = inferAnchor(label, params.instruction);

  const bbox = estimateInitialPlacement({
    instruction: params.instruction,
    label,
    sourceCrop,
    baseWidth: base.width,
    baseHeight: base.height,
    existingLayers: params.existingLayers,
    anchor,
  });

  return {
    id: crypto.randomUUID(),
    label,
    instruction: params.instruction,
    imageData,
    sourceCrop,
    bbox,
    anchor,
    createdStep: params.step,
  };
}

export async function composeImageFromLayers(baseImage: string, layers: ObjectLayer[]): Promise<string> {
  const resolvedBase = await resolveImageToDataUrl(baseImage);
  const base = await loadImage(resolvedBase);

  const canvas = document.createElement("canvas");
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível criar contexto de canvas.");

  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

  for (const layer of layers) {
    const layerImage = await loadImage(layer.imageData);
    const destX = layer.bbox.x * canvas.width;
    const destY = layer.bbox.y * canvas.height;
    const destWidth = layer.bbox.width * canvas.width;
    const destHeight = layer.bbox.height * canvas.height;

    ctx.drawImage(
      layerImage,
      layer.sourceCrop.x,
      layer.sourceCrop.y,
      layer.sourceCrop.width,
      layer.sourceCrop.height,
      destX,
      destY,
      destWidth,
      destHeight
    );
  }

  return canvas.toDataURL("image/png");
}

function resolveTargetLayerIndex(layers: ObjectLayer[], command: ParsedObjectCommand): number {
  if (layers.length === 0) return -1;

  if (command.targetObject === "label" && command.targetLabel) {
    const normalizedTarget = normalizeText(command.targetLabel);
    const found = [...layers]
      .map((layer, index) => ({ layer, index }))
      .reverse()
      .find(({ layer }) => {
        const normalizedLabel = normalizeText(layer.label);
        return normalizedLabel.includes(normalizedTarget) || normalizedTarget.includes(normalizedLabel);
      });

    if (found) return found.index;
  }

  return layers.length - 1;
}

export function applyObjectTransformCommand(
  layers: ObjectLayer[],
  command: ParsedObjectCommand
): { layers: ObjectLayer[]; targetLayer: ObjectLayer | null } {
  const targetIndex = resolveTargetLayerIndex(layers, command);
  if (targetIndex < 0) return { layers, targetLayer: null };

  const targetLayer = layers[targetIndex];
  const bbox = targetLayer.bbox;
  const transform = command.transform;

  const scale = clamp(transform.scale ?? 1, 0.2, 3);
  let width = clamp(bbox.width * scale, 0.03, 0.95);
  let height = clamp(bbox.height * scale, 0.03, 0.95);

  if (height > 0.95) {
    height = 0.95;
  }

  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const bottomY = bbox.y + bbox.height;

  const anchor = transform.anchor ?? targetLayer.anchor;
  let x = centerX - width / 2;
  let y = anchor === "ground_center" ? bottomY - height : centerY - height / 2;

  if (typeof transform.centerX === "number") {
    x = transform.centerX - width / 2;
  }
  if (typeof transform.centerY === "number") {
    y = transform.centerY - height / 2;
  }

  x += transform.translateX ?? 0;
  y += transform.translateY ?? 0;

  x = clamp(x, 0, 1 - width);
  y = clamp(y, 0, 1 - height);

  const updatedLayer: ObjectLayer = {
    ...targetLayer,
    anchor,
    bbox: {
      x,
      y,
      width,
      height,
    },
  };

  const updatedLayers = layers.map((layer, index) => (index === targetIndex ? updatedLayer : layer));
  return { layers: updatedLayers, targetLayer: updatedLayer };
}

export function parseObjectTransformPrompt(prompt: string, layers: ObjectLayer[]): ParsedObjectCommand | null {
  if (!prompt.trim()) return null;

  const normalizedPrompt = normalizeText(prompt);
  const hasTransformIntent = /(reduz|diminu|encolh|aument|mova|move|desloc|suba|abaix|centraliz|reposicion|aproxim|afast|tras|frente)/.test(
    normalizedPrompt
  );

  if (!hasTransformIntent) return null;

  const matchedLayer = [...layers]
    .reverse()
    .find((layer) => normalizedPrompt.includes(normalizeText(layer.label)));

  const command: ParsedObjectCommand = {
    action: "transform_object",
    targetObject: matchedLayer ? "label" : "last_added_object",
    targetLabel: matchedLayer?.label,
    transform: {
      anchor: matchedLayer?.anchor ?? "ground_center",
    },
  };

  let scale = 1;
  let hasScale = false;

  const hasReduceWord = /(reduz|diminu|encolh|menor)/.test(normalizedPrompt);
  const hasIncreaseWord = /(aument|maior|amplie)/.test(normalizedPrompt);

  if ((normalizedPrompt.includes("metade") || normalizedPrompt.includes("50%")) && hasReduceWord) {
    scale *= 0.5;
    hasScale = true;
  }

  const smallerMatch = normalizedPrompt.match(/(\d{1,3})\s*%\s*menor/);
  if (smallerMatch) {
    const pct = Number(smallerMatch[1]);
    scale *= clamp(1 - pct / 100, 0.2, 3);
    hasScale = true;
  }

  const biggerMatch = normalizedPrompt.match(/(\d{1,3})\s*%\s*maior/);
  if (biggerMatch) {
    const pct = Number(biggerMatch[1]);
    scale *= clamp(1 + pct / 100, 0.2, 3);
    hasScale = true;
  }

  if (/(dobro|2x|duas vezes)/.test(normalizedPrompt) && hasIncreaseWord) {
    scale *= 2;
    hasScale = true;
  }

  if (
    normalizedPrompt.includes("aumente um pouco") ||
    normalizedPrompt.includes("aumenta um pouco") ||
    normalizedPrompt.includes("um pouco maior")
  ) {
    scale *= 1.15;
    hasScale = true;
  }

  if (
    normalizedPrompt.includes("reduza um pouco") ||
    normalizedPrompt.includes("diminua um pouco") ||
    normalizedPrompt.includes("um pouco menor")
  ) {
    scale *= 0.85;
    hasScale = true;
  }

  if (!hasScale && hasReduceWord) {
    scale *= 0.75;
    hasScale = true;
  }

  if (!hasScale && hasIncreaseWord) {
    scale *= 1.25;
    hasScale = true;
  }

  let translateX = 0;
  let translateY = 0;

  if (normalizedPrompt.includes("direita")) translateX += 0.08;
  if (normalizedPrompt.includes("esquerda")) translateX -= 0.08;
  if (normalizedPrompt.includes("suba") || normalizedPrompt.includes("mais alto") || normalizedPrompt.includes("para cima")) {
    translateY -= 0.08;
  }
  if (normalizedPrompt.includes("abaix") || normalizedPrompt.includes("para baixo")) {
    translateY += 0.08;
  }

  if (
    normalizedPrompt.includes("mais para tras") ||
    normalizedPrompt.includes("para tras") ||
    normalizedPrompt.includes("afaste")
  ) {
    translateY += 0.04;
    scale *= 0.85;
    hasScale = true;
  }

  if (
    normalizedPrompt.includes("mais para frente") ||
    normalizedPrompt.includes("para frente") ||
    normalizedPrompt.includes("aproxime") ||
    normalizedPrompt.includes("aproximar")
  ) {
    translateY -= 0.03;
    scale *= 1.12;
    hasScale = true;
  }

  if (normalizedPrompt.includes("centraliz")) {
    command.transform.centerX = 0.5;
  }

  if (hasScale) {
    command.transform.scale = clamp(scale, 0.2, 3);
  }

  if (translateX !== 0) {
    command.transform.translateX = translateX;
  }

  if (translateY !== 0) {
    command.transform.translateY = translateY;
  }

  const hasTransformValue =
    typeof command.transform.scale === "number" ||
    typeof command.transform.translateX === "number" ||
    typeof command.transform.translateY === "number" ||
    typeof command.transform.centerX === "number" ||
    typeof command.transform.centerY === "number";

  return hasTransformValue ? command : null;
}
