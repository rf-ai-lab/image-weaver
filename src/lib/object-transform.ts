import type { TrackedObject } from "@/contexts/ImageEditorContext";

export type ObjectTransformCommand = {
  action: "transform_object";
  targetObject: "last_added_object" | "by_label";
  targetLabel?: string;
  transform: {
    scale?: number;
    translateXFactor?: number;
    translateYFactor?: number;
    anchor: "center" | "ground_center";
    alignX?: "center";
  };
};

const DIACRITICS_REGEX = /[\u0300-\u036f]/g;

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function extractTargetLabel(normalizedPrompt: string, knownLabels: string[]): string | undefined {
  const normalizedKnownLabels = [...new Set(knownLabels.map((label) => normalizeText(label)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  for (const label of normalizedKnownLabels) {
    if (normalizedPrompt.includes(label)) return label;
  }

  const genericMatch = normalizedPrompt.match(/(?:o|a|os|as)\s+([a-z0-9]+)/);
  return genericMatch?.[1];
}

export function inferObjectLabelFromPrompt(prompt: string): string {
  const normalizedPrompt = normalizeText(prompt);

  const guidedMatch = normalizedPrompt.match(
    /(?:adicione|adicionar|insira|inserir|coloque|usar|use|utilize|utilizar|aplique)\s+(?:um|uma|o|a|os|as|esse|essa|este|esta|tipo de)?\s*([a-z0-9]+)/
  );
  if (guidedMatch?.[1]) return guidedMatch[1];

  const afterDeMatch = normalizedPrompt.match(/de\s+([a-z0-9]+)/);
  if (afterDeMatch?.[1]) return afterDeMatch[1];

  return "objeto";
}

export function parseObjectTransformCommand(prompt: string, knownLabels: string[]): ObjectTransformCommand | null {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) return null;

  const hasTransformIntent = /(reduz|diminu|aument|move|desloc|suba|abaix|esquerd|direit|centraliz|aproxim|tras|atras)/.test(
    normalizedPrompt
  );
  if (!hasTransformIntent) return null;

  let scale: number | undefined;
  let translateXFactor = 0;
  let translateYFactor = 0;
  let alignX: "center" | undefined;

  if (/metade/.test(normalizedPrompt)) {
    scale = 0.5;
  }

  const percentSmaller = normalizedPrompt.match(/(\d{1,3})\s*%\s*menor/);
  if (percentSmaller) {
    const percent = Number(percentSmaller[1]);
    scale = clamp(1 - percent / 100, 0.1, 2);
  }

  const percentBigger = normalizedPrompt.match(/(\d{1,3})\s*%\s*(?:maior|mais\s+maior)/);
  if (percentBigger) {
    const percent = Number(percentBigger[1]);
    scale = clamp(1 + percent / 100, 0.1, 3);
  }

  if (!scale && /(reduz|diminu)/.test(normalizedPrompt)) {
    scale = 0.85;
  }

  if (!scale && /aument/.test(normalizedPrompt)) {
    scale = 1.15;
  }

  if (/esquerd/.test(normalizedPrompt)) {
    translateXFactor -= 0.18;
  }

  if (/direit/.test(normalizedPrompt)) {
    translateXFactor += 0.18;
  }

  if (/suba|cima/.test(normalizedPrompt)) {
    translateYFactor -= 0.18;
  }

  if (/abaix|baixo/.test(normalizedPrompt)) {
    translateYFactor += 0.18;
  }

  if (/centraliz|centro/.test(normalizedPrompt)) {
    alignX = "center";
  }

  if (/mais\s+para\s+tras|mais\s+pra\s+tras|mais\s+para\s+atras|mais\s+pra\s+atras/.test(normalizedPrompt)) {
    scale = clamp((scale ?? 1) * 0.9, 0.1, 2);
    translateYFactor -= 0.08;
  }

  if (/aproxim|mais\s+perto|para\s+frente/.test(normalizedPrompt)) {
    scale = clamp((scale ?? 1) * 1.1, 0.1, 3);
    translateYFactor += 0.05;
  }

  if (!scale && translateXFactor === 0 && translateYFactor === 0 && !alignX) {
    return null;
  }

  const targetLabel = extractTargetLabel(normalizedPrompt, knownLabels);
  const refersToLastObject = /ultimo\s+objeto|ultima\s+decoracao|objeto\s+anterior/.test(normalizedPrompt);

  return {
    action: "transform_object",
    targetObject: refersToLastObject || !targetLabel ? "last_added_object" : "by_label",
    targetLabel: targetLabel || undefined,
    transform: {
      scale,
      translateXFactor,
      translateYFactor,
      anchor: "ground_center",
      alignX,
    },
  };
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Falha ao carregar imagem."));
    img.src = src;
  });
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function hasChangedNeighbor(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (mask[ny * width + nx] === 1) return true;
    }
  }
  return false;
}

export async function detectInsertedObjectFromDiff(params: {
  beforeImage: string;
  afterImage: string;
  label: string;
  versionIndex: number;
}): Promise<TrackedObject | null> {
  const { beforeImage, afterImage, label, versionIndex } = params;

  const [beforeImg, afterImg] = await Promise.all([loadImage(beforeImage), loadImage(afterImage)]);
  const width = afterImg.naturalWidth || afterImg.width;
  const height = afterImg.naturalHeight || afterImg.height;

  if (width <= 0 || height <= 0) return null;

  const beforeCanvas = createCanvas(width, height);
  const beforeCtx = beforeCanvas.getContext("2d");
  if (!beforeCtx) return null;
  beforeCtx.drawImage(beforeImg, 0, 0, width, height);

  const afterCanvas = createCanvas(width, height);
  const afterCtx = afterCanvas.getContext("2d");
  if (!afterCtx) return null;
  afterCtx.drawImage(afterImg, 0, 0, width, height);

  const beforeData = beforeCtx.getImageData(0, 0, width, height).data;
  const afterData = afterCtx.getImageData(0, 0, width, height).data;

  const mask = new Uint8Array(width * height);
  const threshold = 48;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let changedPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * 4;
      const diff =
        Math.abs(beforeData[pixelIndex] - afterData[pixelIndex]) +
        Math.abs(beforeData[pixelIndex + 1] - afterData[pixelIndex + 1]) +
        Math.abs(beforeData[pixelIndex + 2] - afterData[pixelIndex + 2]) +
        Math.abs(beforeData[pixelIndex + 3] - afterData[pixelIndex + 3]);

      if (diff > threshold) {
        mask[y * width + x] = 1;
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (changedPixels < width * height * 0.001 || maxX < minX || maxY < minY) {
    return null;
  }

  const padding = 6;
  const bbox = {
    x: clamp(minX - padding, 0, width - 1),
    y: clamp(minY - padding, 0, height - 1),
    width: clamp(maxX - minX + 1 + padding * 2, 1, width),
    height: clamp(maxY - minY + 1 + padding * 2, 1, height),
  };

  const areaRatio = (bbox.width * bbox.height) / (width * height);
  if (areaRatio > 0.55 || bbox.width < 8 || bbox.height < 8) {
    return null;
  }

  const objectCanvas = createCanvas(bbox.width, bbox.height);
  const objectCtx = objectCanvas.getContext("2d");
  if (!objectCtx) return null;

  const objectImage = objectCtx.createImageData(bbox.width, bbox.height);

  for (let y = 0; y < bbox.height; y++) {
    for (let x = 0; x < bbox.width; x++) {
      const globalX = bbox.x + x;
      const globalY = bbox.y + y;
      if (globalX >= width || globalY >= height) continue;

      const globalMaskIndex = globalY * width + globalX;
      const keepPixel = mask[globalMaskIndex] === 1 || hasChangedNeighbor(mask, width, height, globalX, globalY);
      const sourcePixelIndex = globalMaskIndex * 4;
      const targetPixelIndex = (y * bbox.width + x) * 4;

      if (keepPixel) {
        objectImage.data[targetPixelIndex] = afterData[sourcePixelIndex];
        objectImage.data[targetPixelIndex + 1] = afterData[sourcePixelIndex + 1];
        objectImage.data[targetPixelIndex + 2] = afterData[sourcePixelIndex + 2];
        objectImage.data[targetPixelIndex + 3] = afterData[sourcePixelIndex + 3];
      }
    }
  }

  objectCtx.putImageData(objectImage, 0, 0);

  return {
    id: crypto.randomUUID(),
    label,
    imageData: objectCanvas.toDataURL("image/png"),
    bbox,
    backgroundImage: beforeImage,
    createdAtVersion: versionIndex,
    updatedAtVersion: versionIndex,
  };
}

export async function applyTrackedObjectTransform(params: {
  sceneImage: string;
  targetObject: TrackedObject;
  command: ObjectTransformCommand;
  nextVersionIndex: number;
}): Promise<{ imageUrl: string; updatedObject: TrackedObject }> {
  const { sceneImage, targetObject, command, nextVersionIndex } = params;

  const [sceneImg, backgroundImg, objectImg] = await Promise.all([
    loadImage(sceneImage),
    loadImage(targetObject.backgroundImage),
    loadImage(targetObject.imageData),
  ]);

  const width = sceneImg.naturalWidth || sceneImg.width;
  const height = sceneImg.naturalHeight || sceneImg.height;

  const workCanvas = createCanvas(width, height);
  const workCtx = workCanvas.getContext("2d");
  if (!workCtx) throw new Error("Falha ao preparar canvas de edição.");

  workCtx.drawImage(sceneImg, 0, 0, width, height);

  const old = targetObject.bbox;
  workCtx.drawImage(
    backgroundImg,
    old.x,
    old.y,
    old.width,
    old.height,
    old.x,
    old.y,
    old.width,
    old.height
  );

  const cleanBackground = workCanvas.toDataURL("image/png");

  const scale = command.transform.scale ?? 1;
  const newWidth = clamp(Math.round(old.width * scale), 2, width);
  const newHeight = clamp(Math.round(old.height * scale), 2, height);

  const anchor = command.transform.anchor;
  let x = old.x + (old.width - newWidth) / 2;
  let y =
    anchor === "ground_center"
      ? old.y + old.height - newHeight
      : old.y + (old.height - newHeight) / 2;

  if (command.transform.alignX === "center") {
    x = (width - newWidth) / 2;
  }

  x += (command.transform.translateXFactor ?? 0) * old.width;
  y += (command.transform.translateYFactor ?? 0) * old.height;

  x = clamp(Math.round(x), 0, width - newWidth);
  y = clamp(Math.round(y), 0, height - newHeight);

  workCtx.drawImage(objectImg, x, y, newWidth, newHeight);

  return {
    imageUrl: workCanvas.toDataURL("image/png"),
    updatedObject: {
      ...targetObject,
      bbox: {
        x,
        y,
        width: newWidth,
        height: newHeight,
      },
      backgroundImage: cleanBackground,
      updatedAtVersion: nextVersionIndex,
    },
  };
}
