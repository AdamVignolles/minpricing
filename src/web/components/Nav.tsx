import { Link } from "alepha/react/router";
import type { FC, ReactNode } from "react";

export interface NavProps {
  children: ReactNode;
}

/**
 * Shared shell for every page: a small top bar (private console, no public
 * branding needed) plus the page content.
 */
const Nav: FC<NavProps> = ({ children }) => {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-semibold text-slate-900">
            DealRadar
          </Link>
          <nav className="flex gap-4 text-sm text-slate-600">
            <Link href="/" className="hover:text-slate-900">
              Deals
            </Link>
            <Link href="/admin" className="hover:text-slate-900">
              Admin
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
};

export default Nav;
