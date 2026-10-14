"use client";

import { useCallback, useRef, useState } from "react";
import { SectionWrapper } from "./section-wrapper";

interface VideoFeature {
  title: string;
  badge: "Free" | "Pro";
  description: string;
  videoSrc: string;
}

interface CompactFeature {
  keyword: string;
  title: string;
  description: string;
}

const videoFeatures: VideoFeature[] = [
  {
    title: "Built-in .env & secret editor",
    badge: "Free",
    description:
      "Paste your .env file, import from Doppler, Infisical, or 1Password, and edit secrets directly in the TUI. Encrypted on your device before upload.",
    videoSrc: "/videos/editor-demo.mp4",
  },
  {
    title: "Encrypted team sharing",
    badge: "Pro",
    description:
      "Stop sending .env files over Slack. Share projects with teammates by email, wrapped with each person's own encryption keys and instant revocation.",
    videoSrc: "/videos/collaboration-demo.mp4",
  },
  {
    title: "CI/CD & OIDC pipelines",
    badge: "Pro",
    description:
      "Inject secrets into GitHub Actions, GitLab CI, or any pipeline using service accounts and passwordless OIDC trust policies.",
    videoSrc: "/videos/cicd-demo.mp4",
  },
];

const compactFeatures: CompactFeature[] = [
  {
    keyword: "relic mcp",
    title: "AI-safe MCP server",
    description:
      "Let Cursor, Claude Code, Codex, and Zed run commands with secrets injected while values stay hidden and redacted from AI context.",
  },
  {
    keyword: "relic push",
    title: "Direct platform sync",
    description:
      "Decrypt locally and push straight to Vercel, Cloudflare, GitHub Actions, Fly.io, and more with diff plans (+, ~, -).",
  },
  {
    keyword: "relic run",
    title: "Runtime memory injection",
    description:
      "Inject environment variables into any process or subshell via a native Rust runner, with no plaintext .env files needed on disk.",
  },
  {
    keyword: "relic guard",
    title: "Leak guard & checks",
    description:
      "Block accidental secret or .env commits with pre-commit hooks, and catch missing keys in your code or IDE before deploy.",
  },
];

function Badge({ badge }: { badge: "Free" | "Pro" }) {
  return (
    <span
      className={
        badge === "Pro"
          ? "px-2 py-0.5 text-[10px] font-bold uppercase bg-foreground text-background"
          : "px-2 py-0.5 text-[10px] font-bold uppercase border border-border text-muted-foreground"
      }
    >
      {badge}
    </span>
  );
}

function VideoButton({
  feature,
  videoRef,
  isPlaying,
  playVideo,
  resetVideo,
  toggleVideo,
  className,
}: {
  feature: VideoFeature;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  playVideo: () => void;
  resetVideo: () => void;
  toggleVideo: () => void;
  className?: string;
}) {
  const isHoverDevice = useCallback(() => window.matchMedia("(hover: hover)").matches, []);

  const handleMouseEnter = useCallback(() => {
    if (!isHoverDevice()) return;
    playVideo();
  }, [isHoverDevice, playVideo]);

  const handleMouseLeave = useCallback(() => {
    if (!isHoverDevice()) return;
    resetVideo();
  }, [isHoverDevice, resetVideo]);

  const handleFocus = useCallback(() => {
    if (!isHoverDevice()) return;
    playVideo();
  }, [isHoverDevice, playVideo]);

  const handleBlur = useCallback(() => {
    if (!isHoverDevice()) return;
    resetVideo();
  }, [isHoverDevice, resetVideo]);

  const handleClick = useCallback(() => {
    if (isHoverDevice()) return;
    toggleVideo();
  }, [isHoverDevice, toggleVideo]);

  return (
    <button
      type="button"
      className={`group relative bg-muted/20 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground ${className ?? ""}`}
      aria-label={`${feature.title} preview. Hover or tap to play.`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={handleClick}
    >
      <video
        ref={videoRef}
        src={`${feature.videoSrc}#t=0.001`}
        title={feature.title}
        muted
        playsInline
        preload="metadata"
        className="w-full h-auto"
      />
      <span
        className={`pointer-events-none absolute bottom-3 right-3 border border-white/15 bg-black/75 px-2 py-1 text-[11px] font-medium text-white/80 backdrop-blur-sm transition-all group-hover:border-white/25 group-hover:text-white ${isPlaying ? "opacity-0" : "opacity-100"}`}
      >
        <span className="hidden [@media(hover:hover)]:inline">Hover to play</span>
        <span className="[@media(hover:hover)]:hidden">Tap to play</span>
      </span>
    </button>
  );
}

function useVideoControls() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const playVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      setIsPlaying(true);
    } catch {
      // Ignore autoplay blocking edge cases on unsupported browsers.
    }
  }, []);

  const resetVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    setIsPlaying(false);
  }, []);

  const toggleVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      playVideo();
    } else {
      resetVideo();
    }
  }, [playVideo, resetVideo]);

  return { videoRef, isPlaying, playVideo, resetVideo, toggleVideo };
}

function FeaturedVideoCard({ feature }: { feature: VideoFeature }) {
  const { videoRef, isPlaying, playVideo, resetVideo, toggleVideo } = useVideoControls();

  return (
    <div className="border-2 border-border bg-card flex flex-col md:flex-row hover:border-foreground/30 transition-colors">
      <div className="p-4 sm:p-5 md:p-6 lg:p-8 md:w-2/5 flex flex-col justify-center">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-foreground text-lg">{feature.title}</h3>
          <Badge badge={feature.badge} />
        </div>
        <p className="mt-2 text-sm text-foreground/60 text-pretty sm:text-base">
          {feature.description}
        </p>
      </div>
      <VideoButton
        feature={feature}
        videoRef={videoRef}
        isPlaying={isPlaying}
        playVideo={playVideo}
        resetVideo={resetVideo}
        toggleVideo={toggleVideo}
        className="w-full md:w-3/5 border-t-2 md:border-t-0 md:border-l-2 border-border"
      />
    </div>
  );
}

function VideoCard({ feature }: { feature: VideoFeature }) {
  const { videoRef, isPlaying, playVideo, resetVideo, toggleVideo } = useVideoControls();

  return (
    <div className="border-2 border-border bg-card flex flex-col hover:border-foreground/30 transition-colors">
      <div className="p-4 flex-1 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-foreground">{feature.title}</h3>
          <Badge badge={feature.badge} />
        </div>
        <p className="mt-2 text-sm text-foreground/60 text-pretty">{feature.description}</p>
      </div>
      <VideoButton
        feature={feature}
        videoRef={videoRef}
        isPlaying={isPlaying}
        playVideo={playVideo}
        resetVideo={resetVideo}
        toggleVideo={toggleVideo}
        className="w-full border-t-2 border-border"
      />
    </div>
  );
}

function CompactCard({ feature }: { feature: CompactFeature }) {
  return (
    <div className="border-2 border-border bg-card p-4 hover:border-foreground/30 transition-colors sm:p-5">
      <span className="font-mono text-xs text-electric-ink">{feature.keyword}</span>
      <h3 className="mt-1.5 font-semibold text-foreground text-sm">{feature.title}</h3>
      <p className="mt-2 text-sm text-foreground/60 text-pretty">{feature.description}</p>
    </div>
  );
}

export function Features() {
  return (
    <SectionWrapper label="Features" id="features">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16 lg:px-12">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">Features</h2>
        <p className="mt-2 max-w-2xl text-sm text-foreground/60 text-pretty sm:text-base">
          Everything you need to manage .env secrets across local development, AI coding agents,
          team sharing, and production deploys.
        </p>

        <div className="mt-6 space-y-3 sm:mt-8 sm:space-y-4">
          <FeaturedVideoCard feature={videoFeatures[0]!} />
          <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
            {videoFeatures.slice(1).map((feature) => (
              <VideoCard key={feature.title} feature={feature} />
            ))}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:mt-4 sm:gap-4 lg:grid-cols-4">
          {compactFeatures.map((feature) => (
            <CompactCard key={feature.keyword} feature={feature} />
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
