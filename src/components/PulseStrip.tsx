"use client";

export function PulseStrip() {
  return (
    <div className="relative w-full h-[10px] overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/30 to-transparent animate-pulse" />
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-300/70 to-transparent animate-[pulse_2.5s_linear_infinite]" />
      <div className="absolute left-0 top-1/2 w-full h-px bg-gradient-to-r from-transparent via-yellow-500 to-transparent" />
    </div>
  );
}
