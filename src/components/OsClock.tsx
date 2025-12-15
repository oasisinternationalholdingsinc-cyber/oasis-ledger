"use client";

import { useEffect, useState } from "react";

export function OsClock() {
  const [time, setTime] = useState("");

  useEffect(() => {
    function update() {
      const now = new Date();
      const formatted = now.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setTime(formatted);
    }

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  if (!time) return null;

  return (
    <div className="os-clock-wrap">
      <div className="os-clock-label">LOCAL OPERATOR TIME</div>
      <div className="os-clock-value">{time}</div>
    </div>
  );
}
