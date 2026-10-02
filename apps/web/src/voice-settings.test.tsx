// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {VoiceSettingsPanel} from "./components/VoiceSettingsPanel";
import {api} from "./lib/api";
vi.mock("./lib/api",()=>({api:{voicePreferences:vi.fn(),saveVoicePreferences:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("saves a shared voice explicitly and displays the persisted value on reopening",async()=>{
  vi.mocked(api.voicePreferences).mockResolvedValue({voice:"sol",revision:0,voices:["sol","coral"]});
  vi.mocked(api.saveVoicePreferences).mockResolvedValue({voice:"coral",revision:1,voices:["sol","coral"]});
  const view=render(<VoiceSettingsPanel/>);await screen.findByRole("combobox");
  fireEvent.change(screen.getByRole("combobox"),{target:{value:"coral"}});
  expect(api.saveVoicePreferences).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"保存音色"}));
  await waitFor(()=>expect(api.saveVoicePreferences).toHaveBeenCalledWith({voice:"coral",revision:0}));
  await screen.findByText("音色已保存，下次通话生效。");
  view.unmount();vi.mocked(api.voicePreferences).mockResolvedValue({voice:"coral",revision:1,voices:["sol","coral"]});
  render(<VoiceSettingsPanel/>);expect((await screen.findByRole("combobox") as HTMLSelectElement).value).toBe("coral");
});
it("keeps the draft on a failed save and allows reloading a concurrent update",async()=>{
  vi.mocked(api.voicePreferences).mockResolvedValue({voice:"sol",revision:0,voices:["sol","coral"]});
  vi.mocked(api.saveVoicePreferences).mockRejectedValue(new Error("conflict"));
  render(<VoiceSettingsPanel/>);await screen.findByRole("combobox");
  fireEvent.change(screen.getByRole("combobox"),{target:{value:"coral"}});fireEvent.click(screen.getByRole("button",{name:"保存音色"}));
  await screen.findByRole("alert");expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("coral");
  vi.mocked(api.voicePreferences).mockResolvedValue({voice:"sol",revision:2,voices:["sol","coral"]});
  fireEvent.click(screen.getByRole("button",{name:"重新读取配置"}));
  await waitFor(()=>expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("sol"));
});
