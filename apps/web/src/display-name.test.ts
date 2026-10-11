// @vitest-environment jsdom
import {afterEach, expect, it} from "vitest";
import {displayName, maskPrivateName} from "./lib/display-name";
import {setTheme,type Theme} from "./lib/theme";
afterEach(()=>setTheme("daylight"));
it("masks case-insensitive substrings with exactly four stars",()=>{
 expect(maskPrivateName("CUPSHE / GongQianKun / caGUuu project")).toBe("c****e / g****n / c****u project");
 expect(maskPrivateName("/Users/gongqiankun/Cupshe-seo")).toBe("/Users/g****n/c****e-seo");
});
it.each<Theme>(["official","cyber","daylight","midnight","forest","eyecare","matrix","frozen","wizard","starwars","spirited","rivendell","mario","wukong","nezha","whitesnake","qingming","jiangshan","buzhoushan"])("masks display names in %s without changing canonical data",theme=>{
 const source={name:"CUPSHE project / GongQianKun / caGUuu"};
 setTheme(theme);
 expect(displayName(source.name)).toBe("c****e project / g****n / c****u");
 expect(source.name).toBe("CUPSHE project / GongQianKun / caGUuu");
 expect(displayName(undefined)).toBe("");
 expect(displayName("ordinary host")).toBe("ordinary host");
});
