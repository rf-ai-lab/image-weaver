import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImageEditorProvider } from "@/contexts/ImageEditorContext";
import { useAuth } from "@/hooks/useAuth";
import Header from "@/components/Header";
import Projects from "@/pages/Projects";
import Setup from "@/pages/Setup";
import Editor from "@/pages/Editor";
import Auth from "@/pages/Auth";
import NotFound from "@/pages/NotFound";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient();

const ProtectedRoutes = () => {
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <Auth />;
  }

  return (
    <ImageEditorProvider>
      <div className="flex min-h-screen flex-col bg-background">
        <Header onSignOut={signOut} userEmail={user.email} />
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
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
