import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImageEditorProvider } from "@/contexts/ImageEditorContext";
import Header from "@/components/Header";
import Projects from "@/pages/Projects";
import Setup from "@/pages/Setup";
import Editor from "@/pages/Editor";
import NotFound from "@/pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <ImageEditorProvider>
          <div className="flex min-h-screen flex-col bg-background">
            <Header />
            <main className="flex flex-1 flex-col">
              <Routes>
                <Route path="/" element={<Projects />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="/editor" element={<Editor />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </main>
          </div>
        </ImageEditorProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
