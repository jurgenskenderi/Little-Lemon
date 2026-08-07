import { StatusBar } from "expo-status-bar";

import { DealsScreen } from "./src/screens/DealsScreen";

export default function App() {
  return (
    <>
      <StatusBar style="light" />
      <DealsScreen />
    </>
  );
}
