import { viewContextForPage } from "../../app/navigation";
import { useIsNarrowViewport } from "../../hooks/useIsNarrowViewport";
import type { PageKey, ViewContext } from "../../types/app";

function ModulePageShell({
  title,
  subtitle,
  hideHeading = false,
  page,
  className,
  viewContext,
  tabs,
  actions,
  filters,
  metrics,
  side,
  sideModal = false,
  children,
}: {
  title: string;
  subtitle?: string | null;
  hideHeading?: boolean;
  page?: PageKey;
  className?: string;
  viewContext?: ViewContext | false | null;
  tabs?: React.ReactNode;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  metrics?: React.ReactNode;
  side?: React.ReactNode;
  sideModal?: boolean;
  children: React.ReactNode;
}) {
  const effectiveViewContext = viewContext === false ? null : viewContext ?? (page ? viewContextForPage(page) : null);
  const isNarrowViewport = useIsNarrowViewport();
  const isModalSide = Boolean(side) && (sideModal || isNarrowViewport);
  const pageClassName = ["module-page", page ? `module-page-${page}` : "", className].filter(Boolean).join(" ");
  return (
    <div className={pageClassName}>
      {hideHeading && !actions ? <h1 className="sr-only">{title}</h1> : (
        <div className={`page-head module-head ${hideHeading ? "module-head-actions-only" : ""}`} inert={isModalSide} aria-hidden={isModalSide ? "true" : undefined}>
          {hideHeading ? <h1 className="sr-only">{title}</h1> : (
            <div>
              {effectiveViewContext && <p className="module-eyebrow">{effectiveViewContext.eyebrow}</p>}
              <h1>{title}</h1>
              {subtitle && <p className="page-subtitle">{subtitle}</p>}
            </div>
          )}
          {actions && <div>{actions}</div>}
        </div>
      )}
      <div className={`module-layout ${side && !sideModal ? "has-side" : ""}`}>
        <section className="module-main" inert={isModalSide} aria-hidden={isModalSide ? "true" : undefined}>
          {viewContext && <ModuleViewContext context={viewContext} />}
          {tabs}
          {filters && <div className="module-filter-line">{filters}</div>}
          {metrics && <div className="module-metrics">{metrics}</div>}
          {children}
        </section>
        {side}
      </div>
    </div>
  );
}

function ModuleViewContext({ context }: { context: ViewContext }) {
  return (
    <div className="module-view-context">
      <div>
        <span>{context.eyebrow}</span>
        <strong>{context.title}</strong>
      </div>
      <div>
        {context.chips.map((chip) => <em key={chip}>{chip}</em>)}
      </div>
    </div>
  );
}

export { ModulePageShell, ModuleViewContext };
