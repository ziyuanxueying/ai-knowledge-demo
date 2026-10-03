/**
 * 移动端打开侧边栏的菜单按钮（桌面端由 CSS 隐藏）
 */
export default function MenuButton({ onClick }) {
  if (!onClick) return null;
  return (
    <button
      type="button"
      className="mobile-menu-btn"
      onClick={onClick}
      aria-label="打开菜单"
    >
      <span className="mobile-menu-icon" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </button>
  );
}
