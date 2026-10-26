import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./dark.css";
import App from "./App.js";
createRoot(document.getElementById("root")!).render(<App />);
