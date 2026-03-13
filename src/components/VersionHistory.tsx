import { useImageEditor } from "@/contexts/ImageEditorContext";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X } from "lucide-react";

const VersionHistory = () => {
  const { versions, currentVersionIndex, setCurrentVersion, deleteVersion } = useImageEditor();

  if (versions.length === 0) return null;

  return (
    <div className="border-t border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Histórico de Versões
      </h3>
      <ScrollArea className="w-full">
        <div className="flex gap-3 pb-2">
          {versions.map((v, i) => (
            <div key={i} className="relative group">
              <button
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
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteVersion(i);
                }}
                className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 transition-colors"
                title="Excluir versão"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default VersionHistory;