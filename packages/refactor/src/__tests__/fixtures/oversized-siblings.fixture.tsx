// fixture: 6 个兄弟组件，各自真实 JSX 深度仅 2 层（div > button）
// 回归目标：computeJsxDepthFromAst 不得用共享可变计数器在兄弟子树间泄漏深度
// （旧实现 6 个兄弟会把 2 层深度累加成 12 层 > 阈值 5 → 误报）
interface SiblingProps {
  value: number;
  onSelect: (v: number) => void;
}

function SiblingOne({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}

function SiblingTwo({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}

function SiblingThree({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}

function SiblingFour({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}

function SiblingFive({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}

function SiblingSix({ value, onSelect }: SiblingProps) {
  return (
    <div className="item">
      <button onClick={() => onSelect(value)}>{value}</button>
    </div>
  );
}