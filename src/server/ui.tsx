export function MissingConfigurationPanel({
  title,
  missing
}: {
  title: string;
  missing: readonly string[];
}) {
  return (
    <main className="main">
      <section className="panel">
        <h1>{title}</h1>
        <p>Runtime configuration is missing required variable names.</p>
        <ul>
          {missing.map((name) => (
            <li key={name}>
              <code>{name}</code>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
