import { useImageEditor } from "@/contexts/ImageEditorContext";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

const VersionHistory = () => {
  const { versions, currentVersionIndex, setCurrentVersion } = useImageEditor();

  if (versions.length === 0) return null;

  return (
    <div className="border-t border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Histórico de Versões
      </h3>
      <ScrollArea className="w-full">
        <div className="flex gap-3 pb-2">
          {versions.map((v, i) => (
            <button
              key={i}
              onClick={() => setCurrentVersion(i)}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border-2 p-1.5 transition-all hover:border-primary/50",
                i === currentVersionIndex ? "border-primary shadow-sm" : "border-transparent"
              )}
            >
              <img
                src={v.imageData}
                alt={v.label}
                className="h-16 w-16 rounded object-cover"
              />
              <span className="text-[10px] font-medium text-muted-foreground">{v.label}</span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default VersionHistory;
