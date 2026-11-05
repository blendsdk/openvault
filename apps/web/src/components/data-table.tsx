import type { ReactNode } from "react";

/** One table column. */
export interface DataColumn<T> {
  /** Stable key. */
  readonly key: string;
  /** Visible header. */
  readonly header: string;
  /** Cell renderer. */
  readonly render: (row: T) => ReactNode;
  /** Optional CSS width. */
  readonly width?: string;
}

/**
 * A semantic, horizontally scrollable table with a caption.
 *
 * The caption is visually hidden but available to assistive technology. The
 * scroll region is focusable so keyboard users can reach the horizontal
 * overflow at narrow widths.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  busy = false,
  emptyMessage = "No rows",
}: {
  readonly caption: string;
  readonly columns: ReadonlyArray<DataColumn<T>>;
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly busy?: boolean;
  readonly emptyMessage?: string;
}) {
  return (
    <section
      className="table-scroll"
      aria-label={caption}
      aria-busy={busy}
      // A wide table must be reachable with the keyboard at narrow widths.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region
      tabIndex={0}
    >
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
