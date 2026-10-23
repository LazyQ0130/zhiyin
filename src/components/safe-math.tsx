"use client";
import { Fragment, useEffect, useRef } from "react";
import katex from "katex";

function Formula({ source, display }: { source: string; display: boolean }) {
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!container.current) return;
    // KaTeX owns only this node. Text is never interpreted as arbitrary HTML;
    // links, HTML extensions and external resources stay disabled with trust:false.
    katex.render(source, container.current, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20, output: "htmlAndMathml" });
  }, [source, display]);
  return <span ref={container} className="safe-formula">{source}</span>;
}
export function SafeMath({ text }: { text: string }) {
  const segments = text.split(/(\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return <span className="safe-math">{segments.map((segment, index) => {
    const display = segment.startsWith("\\[") || segment.startsWith("$$");
    const inline = segment.startsWith("\\(") || (segment.startsWith("$") && segment.endsWith("$") && segment.length > 2);
    if (display || inline) { const size = segment.startsWith("$") && !display ? 1 : 2; return <Formula key={index} source={segment.slice(size, -size)} display={display} />; }
    return <Fragment key={index}>{segment}</Fragment>;
  })}</span>;
}
