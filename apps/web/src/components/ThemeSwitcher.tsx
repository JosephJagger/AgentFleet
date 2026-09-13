import { Check, Radio, Snowflake, SunMoon, Wand2, Orbit, Flower2, Leaf, Gamepad2, Zap, Cloud, Shield, TreePine, Heart } from "lucide-react";
import { t } from "../i18n";
import { setTheme, useTheme, type Theme } from "../lib/theme";

export function ThemeEmblem() {
  const selected = useTheme();
  const Icon = ({ daylight: Cloud, midnight: Shield, forest: TreePine, eyecare: Heart, wukong: SunMoon, nezha: Flower2, whitesnake: Leaf, qingming: Cloud, jiangshan: TreePine, frozen: Snowflake, wizard: Wand2, starwars: Orbit, spirited: Flower2, rivendell: Leaf, mario: Gamepad2, cyber: Zap } as Partial<Record<Theme, typeof Radio>>)[selected] ?? Radio;
  return <Icon size={18} aria-hidden="true" />;
}

export function ThemeSwitcher({ onChange }: { onChange?: () => void } = {}) {
  const selected = useTheme();
  return (
    <label className="theme-switcher">
      <SunMoon size={15} aria-hidden="true" />
      <select aria-label={t("界面主题")} value={selected} onChange={event => { setTheme(event.target.value as Theme); onChange?.(); }}>
        <option value="cyber">{t("赛博朋克")}</option>
        <option value="daylight">{t("天空之城")}</option>
        <option value="midnight">{t("黑暗骑士")}</option>
        <option value="forest">{t("龙猫森林")}</option>
        <option value="eyecare">{t("彼得兔园")}</option>
        <option value="matrix">{t("骇客帝国")}</option>
        <option value="frozen">{t("冰雪奇缘")}</option>
        <option value="wizard">{t("哈利波特")}</option>
        <option value="starwars">{t("星球大战")}</option>
        <option value="spirited">{t("千与千寻")}</option>
        <option value="rivendell">{t("指环王")}</option>
        <option value="mario">{t("超级马里奥")}</option>
        <option value="wukong">{t("大闹天宫")}</option>
        <option value="nezha">{t("哪吒闹海")}</option>
        <option value="whitesnake">{t("白蛇传说")}</option>
        <option value="qingming">{t("清明上河")}</option>
        <option value="jiangshan">{t("千里江山")}</option>
      </select>
    </label>
  );
}

const themeOptions: { value: Theme; label: string; description: string }[] = [
  { value: "cyber", label: "赛博朋克", description: "夜之城剪影、警示黄与工业切角" },
  { value: "daylight", label: "天空之城", description: "云海浮岛、飞行石与轻盈白蓝" },
  { value: "midnight", label: "黑暗骑士", description: "哥谭夜幕、蝙蝠探照灯与装甲边框" },
  { value: "forest", label: "龙猫森林", description: "森林树洞、叶伞与安静苔绿" },
  { value: "eyecare", label: "彼得兔园", description: "蓝衣兔子、菜园篱笆与暖色信纸" },
  { value: "matrix", label: "骇客帝国", description: "深黑终端，荧光绿信号与微光边界" },
  { value: "frozen", label: "冰雪奇缘", description: "冰晶宫殿、雪花纹饰与通透冰蓝" },
  { value: "wizard", label: "哈利波特", description: "星夜城堡、羊皮纸与古铜魔法书" },
  { value: "starwars", label: "星球大战", description: "深空舰桥、舷窗与光剑蓝信号" },
  { value: "spirited", label: "千与千寻", description: "汤屋夜灯、朱红木牌与温润信纸" },
  { value: "rivendell", label: "指环王", description: "瑞文戴尔山谷、精灵拱门与金色叶纹" },
  { value: "mario", label: "超级马里奥", description: "蘑菇王国、像素丘陵与关卡卡片" },
  { value: "wukong", label: "大闹天宫", description: "天宫云阙、金箍纹饰与朱红鎏金" },
  { value: "nezha", label: "哪吒闹海", description: "莲花水纹、混天绫与朱砂暖白" },
  { value: "whitesnake", label: "白蛇传说", description: "断桥烟雨、青白瓷色与水波细线" },
  { value: "qingming", label: "清明上河", description: "汴京舟桥、绢本淡墨与宋画暖褐" },
  { value: "jiangshan", label: "千里江山", description: "青绿山水、石青石绿与绢本金边" },
];
const illustrated = (value: Theme) => value !== "matrix";
const sceneAsset = (value: Theme) => value === "eyecare" ? "rabbit" : value;

export function ThemeSettings() {
  const selected = useTheme();
  return (
    <>
    {illustrated(selected) && <div className={`theme-scene theme-scene--${selected}`} aria-hidden="true"><img src={`/themes/${sceneAsset(selected)}.svg`} alt="" /></div>}
    <div className="theme-options" role="radiogroup" aria-label={t("界面主题")}>
      {themeOptions.map(option => (
        <button
          className={`theme-option theme-option--${option.value}`}
          type="button"
          role="radio"
          aria-checked={selected === option.value}
          key={option.value}
          onClick={() => setTheme(option.value)}
        >
          <span className="theme-option__preview" aria-hidden="true">{illustrated(option.value) ? <img src={`/themes/${sceneAsset(option.value)}.svg`} alt="" /> : <><i /><i /><i /></>}</span>
          <span className="theme-option__copy"><strong>{t(option.label)}</strong><small>{t(option.description)}</small></span>
          <span className="theme-option__check" aria-hidden="true">{selected === option.value && <Check size={14} />}</span>
        </button>
      ))}
    </div>
    </>
  );
}
