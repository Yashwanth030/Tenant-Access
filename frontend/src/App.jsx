import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login";
import TenantAccess from "./pages/TenantAccess";
import Unauthorized from "./pages/Unauthorized";
import StatusOverview from "./pages/StatusOverview";
import JmsQueues from "./pages/JmsQueues";
import ProtectedRoute from "./components/ProtectedRoute";
import AppChatbot from "./components/AppChatbot";

function App() {
    return (
        <BrowserRouter>
            <AppChatbot />
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/unauthorized" element={<Unauthorized />} />
                <Route path="/tenant" element={<TenantAccess />} />
                <Route path="/status" element={
                    <ProtectedRoute>
                        <StatusOverview />
                    </ProtectedRoute>
                } />
                <Route path="/jms-queues" element={
                    <ProtectedRoute>
                        <JmsQueues />
                    </ProtectedRoute>
                } />
            </Routes>
        </BrowserRouter>
    );
}

export default App;
