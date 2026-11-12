import { ChevronDown, ChevronLeft, CloudCog, Menu } from "lucide-react";
import { useState } from "react";
import { activeChildForPage, navChildMetaText, navItemsForPermissions, navPageFor } from "../../app/navigation";
import type { Permission } from "@stackpilot/contracts";
import type { NavChild, NavItem } from "./types";
import type { PageKey, SetPage } from "../../types/app";

function Sidebar({
  page,
  setPage,
  collapsed,
  onToggleCollapsed,
  onExpandCollapsed,
  onNavigate,
  permissions,
}: {
  page: PageKey;
  setPage: SetPage;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onExpandCollapsed: () => void;
  onNavigate: () => void;
  permissions: Permission[];
}) {
  const activeParent = navPageFor(page);
  const activeChild = activeChildForPage(page);
  const [openOverride, setOpenOverride] = useState<{
    source: NavItem["key"];
    target: NavItem["key"];
    group: NavItem["key"] | null;
  } | null>(null);
  const overrideApplies = openOverride
    && (activeParent === openOverride.source || activeParent === openOverride.target);
  const openGroup = overrideApplies ? openOverride.group : activeParent;

  const openParent = (item: NavItem) => {
    const currentOpen = openGroup === item.key;
    setOpenOverride({
      source: activeParent,
      target: item.key,
      group: collapsed ? item.key : currentOpen ? null : item.key,
    });
    setPage(item.key, { message: `已进入${item.label}`, tone: "info" });
    if (collapsed) onExpandCollapsed();
  };

  const openChild = (parent: NavItem, child: NavChild) => {
    setOpenOverride({ source: activeParent, target: parent.key, group: parent.key });
    setPage(child.page ?? child.id, { message: `已打开${parent.label} / ${child.label}`, tone: "info" });
    onNavigate();
  };

  return (
    <aside className={`cloud-sidebar ${collapsed ? "is-collapsed" : ""}`} data-sidebar-root>
      <div className="cloud-sidebar-brand">
        <span className="cloud-sidebar-logo" aria-hidden="true"><CloudCog size={20} /></span>
        <span className="cloud-sidebar-brand-copy">
          <strong>StackPilot</strong>
          <small>Control plane</small>
        </span>
      </div>

      <nav className="cloud-sidebar-nav" aria-label="主导航">
        {navItemsForPermissions(permissions).map((item) => {
          const children = item.children;
          const Icon = item.icon;
          const isActiveParent = item.key === activeParent;
          const isExactPage = item.key === page;
          const isOpen = openGroup === item.key && !collapsed;
          return (
            <section
              key={item.key}
              className={`cloud-sidebar-group ${isActiveParent ? "is-active" : ""} ${isOpen ? "is-open" : ""}`}
            >
              <button
                className="cloud-sidebar-parent"
                type="button"
                onClick={() => openParent(item)}
                aria-current={isExactPage ? "page" : undefined}
                aria-expanded={isOpen}
                aria-controls={`cloud-sidebar-children-${item.key}`}
                title={collapsed ? item.label : undefined}
              >
                <Icon className="cloud-sidebar-parent-icon" size={20} aria-hidden="true" />
                <span className="cloud-sidebar-parent-label">{item.label}</span>
                {item.badge && <strong className="cloud-sidebar-badge">{item.badge}</strong>}
                <ChevronDown className="cloud-sidebar-chevron" size={16} aria-hidden="true" />
              </button>

              <div
                className="cloud-sidebar-children"
                id={`cloud-sidebar-children-${item.key}`}
                aria-hidden={!isOpen}
                hidden={!isOpen}
              >
                <div className="cloud-sidebar-children-inner">
                  {children.map((child) => {
                    const metaText = navChildMetaText(child);
                    const isActiveChild = activeChild === child.id;
                    return (
                      <button
                        key={child.id}
                        className={`cloud-sidebar-child ${isActiveChild ? "is-active" : ""}`}
                        type="button"
                        tabIndex={isOpen ? 0 : -1}
                        aria-current={isOpen && isActiveChild ? "page" : undefined}
                        title={metaText || undefined}
                        onClick={() => openChild(item, child)}
                      >
                        <span>
                          <strong>{child.label}</strong>
                        </span>
                        {child.badge && <em>{child.badge}</em>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </nav>

      <button
        className="cloud-sidebar-collapse"
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        title={collapsed ? "展开侧栏" : undefined}
      >
        <span className="cloud-sidebar-collapse-icons" aria-hidden="true">
          <ChevronLeft className="cloud-sidebar-collapse-close" size={17} />
          <Menu className="cloud-sidebar-collapse-open" size={17} />
        </span>
        <span>{collapsed ? "展开侧栏" : "收起侧栏"}</span>
      </button>
    </aside>
  );
}

export { Sidebar };
