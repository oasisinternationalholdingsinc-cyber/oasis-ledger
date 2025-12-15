"use client";

export type OrbMode = "nur" | "ruh";

type OasisOrbProps = {
  mode: OrbMode;
  alert?: boolean;
};

export function OasisOrb({ mode, alert = false }: OasisOrbProps) {
  return (
    <div className={`oracle-orb ${mode} ${alert ? "alert" : ""}`}>
      {/* Soft ambient field behind everything */}
      <div className="orb-field" />

      {/* Sentinel shell */}
      <div className="orb-shell">
        {/* Core */}
        <div className="orb-core">
          {/* Rotating scan line */}
          <div className="orb-scan" />

          {/* Small sentinel nodes */}
          <div className="orb-node orb-node-top" />
          <div className="orb-node orb-node-right" />
          <div className="orb-node orb-node-bottom" />
        </div>

        {/* Rings */}
        <div className="orb-ring orb-ring-inner" />
        <div className="orb-ring orb-ring-middle" />
        <div className="orb-ring orb-ring-outer" />
      </div>
    </div>
  );
}
