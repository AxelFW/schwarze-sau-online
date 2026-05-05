import { io } from "socket.io-client";

const socketUrl =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.PROD ? undefined : `${window.location.protocol}//${window.location.hostname}:3001`);

export const socket = io(socketUrl, { autoConnect: false });
