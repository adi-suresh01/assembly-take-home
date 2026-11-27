// The overlay: what you said lives on a highway guide sign; what the car understood is the exit tab.
const fmt = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(2)} s`);

export function Hud({ said, command, commandId, status, error, heardMs, actedMs, mic, speedMph, destination, finale }) {
  if (finale) {
    return (
      <div className="hud">
        <div className="sign sign-finale">Founders, assemble.</div>
        <div className="tab tab-finale">
          AssemblyAI, YC S17
          <span>YC companies get a startup program decision in 48 hours</span>
        </div>
      </div>
    );
  }
  const words = said ? said.split(/\s+/) : [];
  return (
    <div className="hud">
      {words.length > 0 && (
        <div className={`sign${error ? " sign-error" : ""}`} lang="mul">
          {words.map((w, i) => (
            <span key={i} className="word">{w} </span>
          ))}
        </div>
      )}
      {command && (
        <div key={commandId} className="tab">
          {command}
        </div>
      )}
      {status && <div className="status">{status}</div>}
      {command && actedMs != null && (
        <div className="latency">Heard in {fmt(heardMs)}, acted in {fmt(actedMs)}</div>
      )}
      <div className="cluster">
        <span className="speed">{Math.round(speedMph)}</span>
        <span className="unit">mph</span>
        <span className={`mic mic-${mic}`} title={`mic ${mic}`} />
        {destination && <span className="next">Next: {destination}</span>}
      </div>
    </div>
  );
}
