/* @ds-bundle: {"format":4,"namespace":"ZafTechDesignSystem_a3688c","components":[{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Kicker","sourcePath":"components/core/Kicker.jsx"},{"name":"MetricTile","sourcePath":"components/core/MetricTile.jsx"},{"name":"TechTag","sourcePath":"components/core/TechTag.jsx"},{"name":"WindowFrame","sourcePath":"components/core/WindowFrame.jsx"},{"name":"Footer","sourcePath":"components/navigation/Footer.jsx"},{"name":"NavBar","sourcePath":"components/navigation/NavBar.jsx"}],"sourceHashes":{"components/core/Button.jsx":"e806b84e7336","components/core/Card.jsx":"09a32eada26c","components/core/Kicker.jsx":"48ff90f361b4","components/core/MetricTile.jsx":"a072b900502f","components/core/TechTag.jsx":"b0e548fb3e39","components/core/WindowFrame.jsx":"b52137ed0512","components/navigation/Footer.jsx":"f20020d01fa9","components/navigation/NavBar.jsx":"92f34175307e"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.ZafTechDesignSystem_a3688c = window.ZafTechDesignSystem_a3688c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function Button({
  href = "#",
  variant = "primary",
  icon = "arrow",
  external = false,
  children,
  ...rest
}) {
  const cls = variant === "primary" ? "btn-primary" : "btn-ghost";
  const target = external ? "_blank" : undefined;
  const rel = external ? "noopener noreferrer" : undefined;
  return /*#__PURE__*/React.createElement("a", _extends({
    href: href,
    className: cls,
    target: target,
    rel: rel
  }, rest), /*#__PURE__*/React.createElement("span", null, children), icon === "arrow" && /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M5 12h14"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m12 5 7 7-7 7"
  })), icon === "play" && /*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8 5v14l11-7z"
  })));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function Card({
  kicker,
  title,
  body,
  tags,
  href = "#"
}) {
  return /*#__PURE__*/React.createElement("a", {
    href: href,
    className: "card-accent-bar",
    style: {
      display: "block",
      padding: "1.75rem",
      background: "var(--color-onyx-900)",
      border: "1px solid var(--color-onyx-700)",
      transition: "background-color var(--dur-hover) ease"
    }
  }, kicker && /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      color: "var(--color-spruce-400)",
      letterSpacing: ".14em",
      textTransform: "uppercase",
      margin: 0
    }
  }, kicker), /*#__PURE__*/React.createElement("h3", {
    style: {
      marginTop: "1.1rem",
      fontSize: 18,
      fontWeight: 500,
      color: "var(--color-ivory-100)",
      fontFamily: "var(--font-sans)"
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 8,
      color: "var(--color-onyx-300)",
      fontSize: 14,
      lineHeight: 1.6
    }
  }, body), tags && tags.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "1.5rem",
      display: "flex",
      flexWrap: "wrap",
      gap: 6
    }
  }, tags.map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "tech-tag"
  }, t))));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Kicker.jsx
try { (() => {
function Kicker({
  num,
  label,
  tone = "accent"
}) {
  return /*#__PURE__*/React.createElement("p", {
    className: "kicker" + (tone === "muted" ? " kicker-muted" : "")
  }, num && /*#__PURE__*/React.createElement("span", {
    className: "kicker-num"
  }, "// ", num), /*#__PURE__*/React.createElement("span", null, label));
}
Object.assign(__ds_scope, { Kicker });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Kicker.jsx", error: String((e && e.message) || e) }); }

// components/core/MetricTile.jsx
try { (() => {
function MetricTile({
  value,
  label
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "metric-tile"
  }, /*#__PURE__*/React.createElement("div", {
    className: "value"
  }, value), /*#__PURE__*/React.createElement("div", {
    className: "label"
  }, label));
}
Object.assign(__ds_scope, { MetricTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/MetricTile.jsx", error: String((e && e.message) || e) }); }

// components/core/TechTag.jsx
try { (() => {
function TechTag({
  children
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "tech-tag"
  }, children);
}
Object.assign(__ds_scope, { TechTag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/TechTag.jsx", error: String((e && e.message) || e) }); }

// components/core/WindowFrame.jsx
try { (() => {
function WindowFrame({
  filename,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "window-chrome"
  }, /*#__PURE__*/React.createElement("div", {
    className: "window-chrome-bar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "window-chrome-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "window-chrome-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "window-chrome-dot"
  }), /*#__PURE__*/React.createElement("span", {
    className: "window-chrome-filename"
  }, filename)), /*#__PURE__*/React.createElement("div", {
    className: "window-chrome-body"
  }, children));
}
Object.assign(__ds_scope, { WindowFrame });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/WindowFrame.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Footer.jsx
try { (() => {
function Footer() {
  const year = 2026;
  const columns = [{
    title: "Services",
    links: ["Full-stack engineering", "AI & LLM integration", "Cloud & DevOps", "All services"]
  }, {
    title: "Products",
    links: ["Convia", "Mizan", "RMS", "All products"]
  }, {
    title: "Company",
    links: ["About", "Careers", "Contact", "GitHub"]
  }, {
    title: "Legal",
    links: ["Terms", "Privacy", "Cookies"]
  }];
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: "1px solid var(--color-onyx-700)",
      background: "var(--color-onyx-950)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "72rem",
      margin: "0 auto",
      padding: "3rem 1.5rem"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(6, 1fr)",
      gap: "2rem"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: "span 2"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: ".14em",
      color: "var(--color-onyx-300)"
    }
  }, "ZafTech"), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: "1rem",
      fontSize: 14,
      color: "var(--color-onyx-400)",
      lineHeight: 1.6,
      maxWidth: "20rem"
    }
  }, "Production systems for teams that can't afford an outage."), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: "1.5rem",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".14em",
      color: "var(--color-onyx-500)"
    }
  }, "Addis Ababa, Ethiopia")), columns.map(col => /*#__PURE__*/React.createElement("div", {
    key: col.title
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".14em",
      color: "var(--color-spruce-400)",
      marginBottom: "1rem"
    }
  }, col.title), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      padding: 0,
      display: "flex",
      flexDirection: "column",
      gap: "0.75rem"
    }
  }, col.links.map(l => /*#__PURE__*/React.createElement("li", {
    key: l
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    style: {
      fontSize: 14,
      color: "var(--color-onyx-300)"
    }
  }, l))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "3rem",
      paddingTop: "2rem",
      borderTop: "1px solid var(--color-onyx-800)",
      display: "flex",
      justifyContent: "space-between",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".14em",
      color: "var(--color-onyx-500)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "\xA9 ", year, " ZafTech Solutions. All rights reserved."), /*#__PURE__*/React.createElement("span", null, "Built in Astro."))));
}
Object.assign(__ds_scope, { Footer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Footer.jsx", error: String((e && e.message) || e) }); }

// components/navigation/NavBar.jsx
try { (() => {
function NavBar({
  nav,
  activeSection = ""
}) {
  const items = nav || [{
    label: "Services",
    href: "/services"
  }, {
    label: "Products",
    href: "/#products"
  }, {
    label: "Portfolio",
    href: "/#portfolio"
  }, {
    label: "Free Audit",
    href: "/audit"
  }];
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: "sticky",
      top: 0,
      width: "100%",
      zIndex: 50,
      borderBottom: "1px solid var(--color-onyx-700)",
      background: "color-mix(in oklab, var(--color-onyx-950) 95%, transparent)",
      backdropFilter: "blur(6px)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "1rem 1.5rem",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "1.5rem"
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "/",
    "aria-label": "ZafTech home",
    style: {
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 700,
      fontSize: 14,
      letterSpacing: ".08em",
      color: "var(--color-ivory-100)"
    }
  }, "ZAFTECH")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "none"
    },
    className: "navbar-divider"
  }), /*#__PURE__*/React.createElement("nav", {
    "aria-label": "Primary",
    style: {
      display: "flex",
      gap: "1.5rem"
    }
  }, items.map(item => {
    const isCurrent = item.label === activeSection;
    return /*#__PURE__*/React.createElement("a", {
      key: item.label,
      href: item.href,
      "aria-current": isCurrent ? "page" : undefined,
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: ".14em",
        color: isCurrent ? "var(--color-spruce-400)" : "var(--color-onyx-400)"
      }
    }, item.label);
  }))), /*#__PURE__*/React.createElement("a", {
    href: "/#contact",
    style: {
      display: "flex",
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      padding: "0 1.25rem",
      background: "var(--color-spruce-400)",
      color: "var(--color-onyx-950)",
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: ".1em",
      textTransform: "uppercase",
      fontFamily: "var(--font-mono)"
    }
  }, "Start a project")));
}
Object.assign(__ds_scope, { NavBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/NavBar.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Kicker = __ds_scope.Kicker;

__ds_ns.MetricTile = __ds_scope.MetricTile;

__ds_ns.TechTag = __ds_scope.TechTag;

__ds_ns.WindowFrame = __ds_scope.WindowFrame;

__ds_ns.Footer = __ds_scope.Footer;

__ds_ns.NavBar = __ds_scope.NavBar;

})();
