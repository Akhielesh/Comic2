// Shared UUID guard. Several code paths take an id from the client (a connectionId, a
// projectId, an artifact id) and pass it straight to a Postgres `uuid` column. A malformed
// value — most notably the Gallery placeholder "demo-connection" baked into demo confirm
// cards — makes Postgres throw `invalid input syntax for type uuid`, which surfaced as a
// 500 in production. Guarding with this before the query turns those into clean 404s.
export const isUuid = (value?: string | null): boolean =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
